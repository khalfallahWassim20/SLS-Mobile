/** Preuve stricte d'une révision locale v6 non encore acquittée. À appeler sous
 * verrou SQLite exclusif : toute incohérence garde l'ancienne protection. */
import {canonicalJson} from '@sls/domain';
import {readIdentifiedOutbox} from './identified-outbox';
import type {DeviceIdentity} from './identified-device';
import type {readLocalDayInvoiceSource} from './day-invoice-local';
import type {validateDayInvoiceReference} from './day-invoice-reference';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type Local=Awaited<ReturnType<typeof readLocalDayInvoiceSource>>;
type Reference=ReturnType<typeof validateDayInvoiceReference>;
export async function verifiedPendingSaleRevisions(tx:Tx,identity:DeviceIdentity,reference:Reference,local:Local):Promise<Set<string>>{
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
  const {id:_id,...afterPayload}=after;
  if(event.operationId!==entry.operationId||event.saleId!==sale.id||event.version!==sale.version||event.refund!==0||canonicalJson(event.sale)!==canonicalJson(current)||canonicalJson(afterPayload)!==canonicalJson(current))continue;
  verified.add(sale.id);
 }
 return verified;
}
