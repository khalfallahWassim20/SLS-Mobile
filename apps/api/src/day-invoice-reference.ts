/** Référence préparatoire, jamais exposée par l'API normale. Tous les marqueurs
 * et les soldes sont lus dans le même instantané PostgreSQL. */
import type {Pool,PoolClient} from 'pg';
import {summarizePreInvoice,canonicalJson} from '@sls/domain';
import {createHash} from 'node:crypto';
import {readIdentifiedReferenceInTransaction} from './identified-reference.js';
import {parseDayInvoicePayment,dayInvoicePaymentHash} from './day-invoice-protocol.js';
import {lockSyncMode,assertIdentifiedMode} from './tour-sync-mode.js';
import {assertOldCreditProtocolSafe} from './credit-note-active-guards.js';
function tunisDay(iso:string):string {
 const date=new Date(iso);if(typeof iso!=='string'||!Number.isFinite(date.getTime()))throw Error('Date de vente serveur invalide.');
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date),get=(key:string)=>parts.find(p=>p.type===key)?.value;
 return `${get('year')}-${get('month')}-${get('day')}`;
}

export async function readDayInvoiceReferenceInTransaction(db:PoolClient,includeInactive=false) {
 const base=await readIdentifiedReferenceInTransaction(db,includeInactive);
 const active=includeInactive?'':' AND c.active';
 const dayRows=await db.query(`WITH combined AS (
  SELECT sale_id,client_id,version,payload FROM demo_sale_events
  UNION ALL SELECT sale_id,client_id,version,payload FROM identified_sale_events
 ) SELECT DISTINCT ON (s.sale_id) s.sale_id AS "saleId",s.client_id AS "clientId",s.version,s.payload
 FROM combined s JOIN clients c ON c.id=s.client_id WHERE c.deleted_at IS NULL${active} ORDER BY s.sale_id,s.version DESC`);
 const states=new Map(base.saleStates.map(s=>[s.saleId,s]));
 const saleDays=dayRows.rows.map(row=>{const sale=row.payload?.sale,state=states.get(row.saleId);
  if(!state||state.clientId!==row.clientId||state.version!==row.version||sale?.clientId!==row.clientId||sale?.syncSaleId!==row.saleId||sale?.syncVersion!==row.version||String(sale?.total)!==state.total||String(sale?.paid)!==state.paid)throw Error('Journée de vente serveur incohérente.');
  return {saleId:row.saleId as string,clientId:row.clientId as string,day:tunisDay(sale.createdAt)};
 });
 if(saleDays.length!==base.saleStates.length)throw Error('Journées de vente serveur incomplètes.');
 const saleProofs=dayRows.rows.map(row=>({saleId:row.saleId as string,version:row.version as number,hash:createHash('sha256').update(canonicalJson(row.payload.sale)).digest('hex')}));
 const settlementRows=await db.query(`WITH combined AS (
  SELECT operation_id,client_id,payload FROM demo_settlements UNION ALL SELECT operation_id,client_id,payload FROM identified_settlements
 ) SELECT p.operation_id AS "operationId",p.client_id AS "clientId",p.payload FROM combined p
 JOIN clients c ON c.id=p.client_id WHERE c.deleted_at IS NULL${active}`);
 const settlements=new Map(base.settlementStates.map(s=>[s.operationId,s]));
 const settlementDays=settlementRows.rows.map(row=>{const settlement=row.payload?.settlement,state=settlements.get(row.operationId);
  if(!state||state.clientId!==row.clientId||settlement?.clientId!==row.clientId||settlement?.syncOperationId!==row.operationId)throw Error('Journée de règlement serveur incohérente.');
  return {operationId:row.operationId as string,clientId:row.clientId as string,day:tunisDay(settlement.createdAt)};
 });
 if(settlementDays.length!==base.settlementStates.length)throw Error('Journées de règlement serveur incomplètes.');
 const settlementProofs=settlementRows.rows.map(row=>({operationId:row.operationId as string,hash:createHash('sha256').update(canonicalJson(row.payload.settlement)).digest('hex')}));
 const markers=await db.query(`SELECT m.operation_id AS "operationId",m.invoice_day::text AS "invoiceDay" FROM identified_day_invoice_old_debt m JOIN identified_settlements s ON s.operation_id=m.operation_id JOIN clients c ON c.id=s.client_id WHERE c.deleted_at IS NULL${active} ORDER BY m.operation_id`);
 const oldDebtMarkers=markers.rows.map(row=>{if(!settlements.has(row.operationId)||settlementDays.find(d=>d.operationId===row.operationId)?.day!==row.invoiceDay)throw Error('Marqueur de dette incohérent.');return {operationId:row.operationId as string,invoiceDay:row.invoiceDay as string};});
 const rows=await db.query(`SELECT p.operation_id AS "operationId",p.client_id AS "clientId",p.invoice_day::text AS day,p.payload,p.payload_hash AS hash
 FROM identified_day_invoice_payments p JOIN clients c ON c.id=p.client_id WHERE c.deleted_at IS NULL${active} ORDER BY p.operation_id`);
 const operations=await db.query(`SELECT operation_id FROM demo_sale_events UNION ALL SELECT operation_id FROM identified_sale_events
 UNION ALL SELECT operation_id FROM demo_settlements UNION ALL SELECT operation_id FROM identified_settlements
 UNION ALL SELECT operation_id FROM sync_journal_events UNION ALL SELECT operation_id FROM identified_journal_events
 UNION ALL SELECT operation_id FROM identified_tour_expenses UNION ALL SELECT operation_id FROM identified_tour_expense_revisions
 UNION ALL SELECT operation_id FROM identified_tour_expense_cancellations`);
 const operationIds=new Set<string>();for(const row of operations.rows){if(operationIds.has(row.operation_id))throw Error('Identifiant d’opération serveur ambigu.');operationIds.add(row.operation_id);}
 const clients=new Map(base.clients.map(c=>[c.id,c])),declared=new Set<string>();
 const payments=rows.rows.map(row=>{
  const payment=parseDayInvoicePayment(row.payload);
  if(payment.operationId!==row.operationId||payment.clientId!==row.clientId||payment.day!==row.day||dayInvoicePaymentHash(payment)!==row.hash||operationIds.has(payment.operationId))throw Error('Paiement serveur incohérent.');
  operationIds.add(payment.operationId);
  const client=clients.get(payment.clientId);if(!client)throw Error('Client du paiement indisponible.');
  if(payment.preInvoice){
   const invoice=base.journalStates.find(j=>j.id===payment.preInvoice!.id);
   const proof=base.journalProofs.find(p=>p.id===payment.preInvoice!.id);
   if(!invoice||!proof||invoice.clientId!==payment.clientId||invoice.journalDate!==payment.day||invoice.total!==payment.preInvoice.total||proof.version<payment.preInvoice.version)throw Error('Facture du paiement incohérente.');
   if(payment.preInvoice.declare){if(declared.has(invoice.id)||summarizePreInvoice(invoice.total,invoice.receipts).declared)throw Error('Déclaration de facture en conflit.');declared.add(invoice.id);}
  }
  for(const sale of payment.sales){const current=base.saleStates.find(s=>s.saleId===sale.id),dated=saleDays.find(s=>s.saleId===sale.id);if(!current||!dated||dated.day!==payment.day||current.clientId!==payment.clientId||current.version<sale.version)throw Error('Vente du paiement incohérente.');}
  return payment;
 });
 for(const payment of payments)if(payment.preInvoice&&!payment.preInvoice.declare){const invoice=base.journalStates.find(j=>j.id===payment.preInvoice!.id)!;if(!declared.has(invoice.id)&&!summarizePreInvoice(invoice.total,invoice.receipts).declared)throw Error('Facture non déclarée.');}
 const delta=new Map<string,bigint>();
 for(const payment of payments){const before=delta.get(payment.clientId)??0n;delta.set(payment.clientId,before-BigInt(payment.amount)+(payment.preInvoice?.declare?BigInt(payment.preInvoice.total):0n));}
 const projected=base.clients.map(c=>{const balance=BigInt(c.serverBalance)+ (delta.get(c.id)??0n);if(balance>BigInt(Number.MAX_SAFE_INTEGER)||balance<BigInt(Number.MIN_SAFE_INTEGER))throw RangeError('Solde trop élevé.');return {...c,serverBalance:String(balance)};});
 return {...base,version:6 as const,clients:projected,saleDays,saleProofs,settlementDays,settlementProofs,oldDebtMarkers,dayPayments:payments,journalStates:base.journalStates.map(j=>({...j,declaredByDayPayment:declared.has(j.id)}))};
}
export async function readDayInvoiceReference(pool:Pool,includeInactive=false) {
 const db=await pool.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));await assertOldCreditProtocolSafe(db);const result=await readDayInvoiceReferenceInTransaction(db,includeInactive);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
