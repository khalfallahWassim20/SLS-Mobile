/** Preuve stricte d'une révision locale v6 non encore acquittée. À appeler sous
 * verrou SQLite exclusif : toute incohérence garde l'ancienne protection. */
import {canonicalJson,calculateInvoice} from '@sls/domain';
import {readIdentifiedOutbox} from './identified-outbox';
import type {DeviceIdentity} from './identified-device';
import type {readLocalDayInvoiceSource} from './day-invoice-local';
import type {validateDayInvoiceReference} from './day-invoice-reference';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type Local=Awaited<ReturnType<typeof readLocalDayInvoiceSource>>;
type Reference=ReturnType<typeof validateDayInvoiceReference>;
export async function verifiedPendingSaleRevisions(tx:Tx,identity:DeviceIdentity,reference:Reference,local:Local,digest?:(value:string)=>Promise<string>):Promise<Set<string>>{
 const mismatch=local.sales.filter(s=>{const remote=reference.saleStates?.find(r=>r.saleId===s.id);return !!remote&&(remote.version!==s.version||Number(remote.total)!==s.total||Number(remote.paid)!==s.paid);});
 if(!mismatch.length)return new Set();
 const queue=await readIdentifiedOutbox(tx,identity),verified=new Set<string>();
 for(const sale of mismatch){
  const remote=reference.saleStates?.find(r=>r.saleId===sale.id),dated=reference.saleDays.find(r=>r.saleId===sale.id);
  const entries=queue.filter(q=>q.kind==='sale'&&q.entityId===sale.id);
  if(!remote||remote.clientId!==local.clientId||dated?.clientId!==local.clientId||dated.day!==local.day||sale.version!==remote.version+1||entries.length!==1)continue;
  const entry=entries[0];let event:any;try{event=JSON.parse(entry.payload);}catch{continue;}
  const rows=await tx.getAllAsync<{id:number;payload:string}>('SELECT id,payload FROM sales WHERE client_id=?',local.clientId);
  const matches=rows.filter(r=>{try{return JSON.parse(r.payload).syncSaleId===sale.id;}catch{return false;}});
  if(matches.length!==1)continue;
  const row=matches[0],revision=await tx.getFirstAsync<{createdAt:string;previousPayload:string;newPayload:string;refund:number}>(`SELECT created_at AS createdAt,previous_payload AS previousPayload,new_payload AS newPayload,refund FROM sale_revisions WHERE sale_id=? ORDER BY id DESC LIMIT 1`,row.id);
  if(!revision||revision.refund!==0||revision.createdAt!==entry.recordedAt)continue;
  let before:any,after:any,current:any;try{before=JSON.parse(revision.previousPayload);after=JSON.parse(revision.newPayload);current=JSON.parse(row.payload);}catch{continue;}
  if(!before||!after||!current||before.id!==row.id||after.id!==row.id||before.syncSaleId!==sale.id||after.syncSaleId!==sale.id||before.syncVersion!==remote.version||before.clientId!==local.clientId||before.total!==Number(remote.total)||before.paid!==Number(remote.paid)||after.syncVersion!==sale.version||after.clientId!==local.clientId||after.total!==sale.total||after.paid!==sale.paid||after.createdAt!==before.createdAt)continue;
  // Une ancienne preuve de paiement ne peut être rapprochée de la révision
  // que si l'intégralité de la vente précédente correspond au hash serveur.
  if(digest){const proof=reference.saleProofs.find(p=>p.saleId===sale.id),{id:_id,...prior}=before;if(!proof||proof.version!==before.syncVersion||proof.hash!==await digest(canonicalJson(prior)))continue;}
  // Une révision v6 sans remboursement ne peut changer ni le paiement initial
  // ni les champs d'identité ; seuls les articles et totaux sont révisables.
  const {id:_beforeId,lines:_beforeLines,total:_beforeTotal,remaining:_beforeRemaining,syncVersion:_beforeVersion,...beforeFixed}=before;
  const {id:_id,lines:afterLines,total:_afterTotal,remaining:_afterRemaining,syncVersion:_afterVersion,...afterFixed}=after;
  if(canonicalJson(beforeFixed)!==canonicalJson(afterFixed)||!Array.isArray(afterLines)||!afterLines.length)continue;
  try{const total=calculateInvoice(afterLines.map((l:any)=>({quantity:l.quantity,unitPrice:l.unitPrice,discountRate:l.discount,vatRate:l.vat}))).total;if(total!==sale.total||after.remaining!==Math.max(0,sale.total-sale.paid))continue;}catch{continue;}
  const {id:_currentId,...afterPayload}=after;
  if(event.operationId!==entry.operationId||event.saleId!==sale.id||event.version!==sale.version||event.refund!==0||canonicalJson(event.sale)!==canonicalJson(current)||canonicalJson(afterPayload)!==canonicalJson(current))continue;
  verified.add(sale.id);
 }
 return verified;
}
