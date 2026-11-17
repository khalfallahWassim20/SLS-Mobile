/** Vérification avant écriture d'un paiement v6, sous verrou du client.
 * Un paiement ne peut photographier une source ou un paiement plus récent.
 * Les événements historiques sans date de modification ne permettent pas de
 * prouver cet ordre : ils nécessitent un rapprochement avant règlement. */
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {DayInvoicePayment} from '../../../packages/domain/src/day-invoice.js';
import {saleEventSchema,saleSchema} from './identified-operations.js';
import {parseJournalSnapshot,journalSnapshotHash} from './journal-protocol.js';
import {parseStoredDayInvoicePayment} from './day-invoice-protocol.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function assertDayPaymentChronology(db:PoolClient,event:Pick<DayInvoicePayment,'clientId'|'day'|'recordedAt'|'sales'|'preInvoice'>):Promise<void>{
 const at=Date.parse(event.recordedAt);
 const prior=await db.query(`SELECT operation_id,client_id,invoice_day::text AS invoice_day,event_day::text AS event_day,payload,payload_hash FROM identified_day_invoice_payments WHERE client_id=$1 OR payload->>'clientId'=$1::text LIMIT 20001`,[event.clientId]);
 if(prior.rows.length>20000)throw Error('Historique des paiements incomplet.');
 for(const row of prior.rows){const p=parseStoredDayInvoicePayment(row);if(p.clientId!==event.clientId||p.day===event.day&&Date.parse(p.recordedAt)>at)throw Error('Paiement antérieur à un règlement déjà enregistré ou mal attribué.');}
 const sales=await db.query(`WITH combined AS (
   SELECT operation_id,sale_id,client_id,version,payload,payload_hash,true AS identified FROM identified_sale_events WHERE sale_id=ANY($1::uuid[])
   UNION ALL SELECT operation_id,sale_id,client_id,version,payload,payload_hash,false AS identified FROM demo_sale_events WHERE sale_id=ANY($1::uuid[])
  ), ranked AS (SELECT *,row_number() OVER (PARTITION BY sale_id ORDER BY version DESC) AS position FROM combined)
  SELECT * FROM ranked WHERE position<=2 ORDER BY sale_id,version DESC`,[event.sales.map(s=>s.id)]);
 const byId=new Map<string,typeof sales.rows>();for(const row of sales.rows){const list=byId.get(row.sale_id)??[];list.push(row);byId.set(row.sale_id,list);}
 for(const sale of event.sales){
  const rows=byId.get(sale.id)??[],row=rows[0];if(!row||row.version!==sale.version||row.client_id!==event.clientId||rows[1]?.version===row.version)throw Error('Preuve de vente indisponible.');
  let recorded:string;
  if(row.identified){const p=saleEventSchema.parse(row.payload);if(p.operationId!==row.operation_id||p.saleId!==row.sale_id||p.version!==row.version||p.sale.clientId!==row.client_id||p.sale.syncSaleId!==row.sale_id||p.sale.syncVersion!==row.version||hash(p)!==row.payload_hash)throw Error('Preuve de vente incohérente.');recorded=p.recordedAt;}
  else{
   // Les anciennes révisions ne contiennent pas de date de modification.
   const p=row.payload,s=saleSchema.parse(p?.sale);
   if(row.version!==1||!p||Object.keys(p).sort().join(',')!=='operationId,refund,sale,saleId,version'||p.operationId!==row.operation_id||p.saleId!==row.sale_id||p.version!==row.version||s.clientId!==row.client_id||s.syncSaleId!==row.sale_id||s.syncVersion!==row.version||hash({operationId:p.operationId,saleId:p.saleId,version:p.version,sale:s,refund:p.refund})!==row.payload_hash)throw Error('Historique de vente sans date vérifiable.');
   recorded=s.createdAt;
  }
  if(!Number.isFinite(Date.parse(recorded))||Date.parse(recorded)>at)throw Error('Paiement antérieur à une vente ou à sa modification.');
 }
 if(event.preInvoice){
  const rows=await db.query(`SELECT operation_id,invoice_id,version,payload,payload_hash FROM identified_journal_events WHERE invoice_id=$1
    UNION ALL SELECT operation_id,invoice_id,version,payload,payload_hash FROM sync_journal_events WHERE invoice_id=$1 ORDER BY version DESC LIMIT 2`,[event.preInvoice.id]);
  const row=rows.rows[0];if(!row||row.version!==event.preInvoice.version||rows.rows[1]?.version===row.version)throw Error('Preuve de préétablie indisponible.');
  const p=parseJournalSnapshot(row.payload);
  if(p.operationId!==row.operation_id||p.invoice.id!==row.invoice_id||p.invoice.clientId!==event.clientId||p.invoice.journalDate!==event.day||p.version!==row.version||journalSnapshotHash(p)!==row.payload_hash)throw Error('Preuve de préétablie incohérente.');
  if(Date.parse(p.invoice.createdAt)>at||p.receipts.some(r=>Date.parse(r.createdAt)>at))throw Error('Paiement antérieur à la préétablie ou à un règlement de journal.');
 }
}
