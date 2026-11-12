/** Envoi isolé, non utilisé par l'application. L'appelant doit transmettre
 * seulement les avoirs dont toutes les versions antérieures ont été envoyées. */
import type {DeviceIdentity} from './identified-device';
import type {Note} from './credit-note-offline-prototype';
import {ClosedDaySyncError} from './identified-upload';
type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const object=(v:unknown):Record<string,unknown>|null=>typeof v==='object'&&v!==null&&!Array.isArray(v)?v as Record<string,unknown>:null;
export async function uploadPrototypeCreditNotes(notes:Note[],identity:DeviceIdentity,verified:DeviceIdentity,send:(path:string,body:string)=>Promise<Response>,acknowledge:(note:Note,response:unknown)=>Promise<void>):Promise<number> {
 if(!uuid(identity.commercialId)||identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur différent du téléphone lié.');
 const ids=new Set<string>();
 for(const note of notes) {
  const c=note?.command;
  if(!c||!uuid(c.operationId)||!uuid(c.invoiceId)||ids.has(c.operationId)||!Number.isSafeInteger(c.expectedVersion)||c.expectedVersion<1||c.expectedVersion>=1000000||!['refund','credit',null].includes(c.choice)||typeof c.recordedAt!=='string'||!Number.isFinite(Date.parse(c.recordedAt))||new Date(c.recordedAt).toISOString()!==c.recordedAt||note.commercialId!==identity.commercialId||note.serverOrigin!==identity.serverOrigin||!['sale','preinvoice'].includes(note.kind))throw Error('Avoir en attente invalide.');
  ids.add(c.operationId);
 }
 let count=0;
 for(const note of notes){
  const response=await send(note.kind==='sale'?'sales':'preinvoices',JSON.stringify(note.command));
  const body=object(await response.json().catch(()=>null));
  if(!response.ok){
   if(response.status===409&&body?.code==='TOUR_DAY_CLOSED'&&typeof body.day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(body.day)&&uuid(body.commercialId)){
    const d=new Date(`${body.day}T00:00:00.000Z`);
    if(Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===body.day)throw new ClosedDaySyncError(body.day,body.commercialId);
   }
   throw Error(typeof body?.error==='string'&&body.error?body.error.slice(0,300):`Erreur de synchronisation (${response.status}).`);
  }
  if(!body||(body.status!=='received'&&body.status!=='duplicate')||body.operationId!==note.command.operationId)throw Error('Accusé invalide : avoir conservé.');
  await acknowledge(note,body);count++;
 }
 return count;
}
