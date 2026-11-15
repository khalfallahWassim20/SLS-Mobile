/** Transfert préparatoire : non raccordé aux routes ni à la file active. */
import { validateDayPayment, type DayInvoicePayment } from '../../packages/domain/src/day-invoice';
import type {DayInvoiceQueueEntry} from './day-invoice-queue';
import {parseClosedDaySyncError,OperationConflictSyncError} from './identified-upload';
type Response = {ok:boolean;status:number;json:()=>Promise<unknown>};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object=(value:unknown):Record<string,unknown>|null=>typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:null;
/** Pas de suppressions tant que la réponse exacte n'est pas confirmée. */
export function validateDayInvoiceQueue(entries:readonly DayInvoiceQueueEntry[],bound:{commercialId:string;serverOrigin:string},verified:{commercialId:string;serverOrigin:string}):void {
 if(!uuid.test(bound.commercialId) || !bound.serverOrigin || bound.commercialId!==verified.commercialId || bound.serverOrigin!==verified.serverOrigin) throw Error('Identité ou serveur du téléphone incohérent.');
 let previous=0;const seen=new Set<string>();
 for(const entry of entries){
  if(entry.commercialId!==bound.commercialId || entry.serverOrigin!==bound.serverOrigin || !Number.isSafeInteger(entry.sequence)||entry.sequence<=previous||!uuid.test(entry.operationId)||seen.has(entry.operationId))throw Error('File de paiements incohérente.');
  previous=entry.sequence;seen.add(entry.operationId);
  let raw:unknown;try{raw=JSON.parse(entry.payload);}catch{throw Error('Paiement en attente illisible.');}
  const value=object(raw);
  if(!value||value.operationId!==entry.operationId)throw Error('Paiement en attente incohérent.');
  // Ne pas accepter de propriétés inattendues que la vérification ne couvrirait pas.
  const keys=['operationId','clientId','day','recordedAt','amount','mode','chequeNumber','chequeBank','chequeDue','preInvoice','sales'];
  if(Object.keys(value).length!==keys.length||keys.some(key=>!(key in value)))throw Error('Contenu du paiement incohérent.');
  validateDayPayment(value as DayInvoicePayment);
 }
}
export async function uploadDayInvoicePayments(
 entries:readonly DayInvoiceQueueEntry[],
 bound:{commercialId:string;serverOrigin:string}, verified:{commercialId:string;serverOrigin:string},
 send:(payload:string)=>Promise<Response>, acknowledge:(entry:DayInvoiceQueueEntry)=>Promise<void>
):Promise<number> {
 validateDayInvoiceQueue(entries,bound,verified);
 let sent=0;
 for(const entry of entries){
  const response=await send(entry.payload),body=object(await response.json().catch(()=>null));
  if(!response.ok){const closed=parseClosedDaySyncError(response.status,body);if(closed)throw closed;
   const message=typeof body?.error==='string'&&body.error?body.error.slice(0,300):`Erreur serveur (${response.status}).`;
   if(response.status===409)throw new OperationConflictSyncError(message);throw Error(message);
  }
  if(!body||(body.status!=='received'&&body.status!=='duplicate')||body.operationId!==entry.operationId)throw Error('Accusé invalide : opération conservée.');
  await acknowledge(entry);sent++;
 }
 return sent;
}
