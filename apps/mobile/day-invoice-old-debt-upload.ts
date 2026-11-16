/** Envoi v6 des dettes explicitement attribuées, sans effacer l'historique. */
import {parseClosedDaySyncError,OperationConflictSyncError} from './identified-upload';
import {validateOldDebtEvent,type OldDebtEntry} from './day-invoice-old-debt-queue';
type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function validateOldDebtQueue(entries:readonly OldDebtEntry[],identity:{commercialId:string;serverOrigin:string},verified:{commercialId:string;serverOrigin:string}):void{
 if(identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur différent du téléphone lié.');
 let sequence=0;const seen=new Set<string>();
 for(const entry of entries){
  if(entry.commercialId!==identity.commercialId||entry.serverOrigin!==identity.serverOrigin||!Number.isSafeInteger(entry.sequence)||entry.sequence<=sequence||seen.has(entry.operationId))throw Error('File ancienne dette incohérente.');sequence=entry.sequence;seen.add(entry.operationId);
  let event:unknown;try{event=JSON.parse(entry.payload);validateOldDebtEvent(event);}catch{throw Error('File ancienne dette illisible.');}
  if((event as {event:{operationId:string}}).event.operationId!==entry.operationId)throw Error('File ancienne dette incohérente.');
 }
}
export async function uploadOldDebts(entries:readonly OldDebtEntry[],identity:{commercialId:string;serverOrigin:string},verified:{commercialId:string;serverOrigin:string},send:(payload:string)=>Promise<Response>,acknowledge:(entry:OldDebtEntry)=>Promise<void>):Promise<number>{
 validateOldDebtQueue(entries,identity,verified);
 let count=0;
 for(const entry of entries){const response=await send(entry.payload),body=await response.json().catch(()=>null);
  if(!response.ok){const closed=parseClosedDaySyncError(response.status,body);if(closed)throw closed;const message=object(body)&&typeof body.error==='string'?body.error.slice(0,300):`Erreur serveur (${response.status}).`;if(response.status===409)throw new OperationConflictSyncError(message);throw Error(message);}
  if(!object(body)||!['received','duplicate'].includes(body.status as string)||body.operationId!==entry.operationId)throw Error('Accusé invalide : opération conservée.');
  await acknowledge(entry);count++;
 }
 return count;
}
