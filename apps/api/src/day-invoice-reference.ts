/** Référence préparatoire, jamais exposée par l'API normale. Tous les marqueurs
 * et les soldes sont lus dans le même instantané PostgreSQL. */
import type {Pool,PoolClient} from 'pg';
import {assertNoUnprojectedCompensation,compensationHash,compensationSchema} from './day-invoice-compensation.js';
import {readSourceForCompensationCheck} from './day-invoice-source.js';
import {saleEventSchema} from './identified-operations.js';
import {assessDayInvoiceSaleRevision,type DayInvoicePayment} from '../../../packages/domain/src/day-invoice.js';
import {summarizePreInvoice,canonicalJson} from '@sls/domain';
import {createHash} from 'node:crypto';
import {readIdentifiedReferenceInTransaction} from './identified-reference.js';
import {parseStoredDayInvoicePayment} from './day-invoice-protocol.js';
import {parseStoredOldDebt} from './settlement-protocol.js';
import {lockSyncMode,assertIdentifiedMode} from './tour-sync-mode.js';
import {assertOldCreditProtocolSafe} from './credit-note-active-guards.js';
function tunisDay(iso:string):string {
 const date=new Date(iso);if(typeof iso!=='string'||!Number.isFinite(date.getTime()))throw Error('Date de vente serveur invalide.');
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date),get=(key:string)=>parts.find(p=>p.type===key)?.value;
 return `${get('year')}-${get('month')}-${get('day')}`;
}

export async function readDayInvoiceReferenceInTransaction(db:PoolClient,includeInactive=false) {
 await assertNoUnprojectedCompensation(db);
 return readUnprojectedDayInvoiceReference(db,includeInactive);
}
/** Utilisé uniquement par la vérification interne de compensation ; ce solde
 * brut ne tient pas encore compte du remboursement enregistré. */
async function readUnprojectedDayInvoiceReference(db:PoolClient,includeInactive=false) {
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
 const markers=await db.query(`SELECT s.operation_id,s.client_id,s.journal_date::text AS journal_day,m.invoice_day::text AS invoice_day,s.payload,s.payload_hash
 FROM identified_day_invoice_old_debt m JOIN identified_settlements s ON s.operation_id=m.operation_id JOIN clients c ON c.id=s.client_id WHERE c.deleted_at IS NULL${active} ORDER BY m.operation_id`);
 const settlementDayById=new Map(settlementDays.map(d=>[d.operationId,d.day]));
 const oldDebtMarkers=markers.rows.map(row=>{try{parseStoredOldDebt(row);}catch{throw Error('Marqueur de dette incohérent.');}if(!settlements.has(row.operation_id)||settlementDayById.get(row.operation_id)!==row.invoice_day)throw Error('Marqueur de dette incohérent.');return {operationId:row.operation_id as string,invoiceDay:row.invoice_day as string};});
 const rows=await db.query(`SELECT p.operation_id AS "operationId",p.client_id AS "clientId",p.invoice_day::text AS day,p.event_day::text AS "eventDay",p.payload,p.payload_hash AS hash
 FROM identified_day_invoice_payments p JOIN clients c ON c.id=p.client_id WHERE c.deleted_at IS NULL${active} ORDER BY p.operation_id`);
 const operations=await db.query(`SELECT operation_id FROM demo_sale_events UNION ALL SELECT operation_id FROM identified_sale_events
 UNION ALL SELECT operation_id FROM demo_settlements UNION ALL SELECT operation_id FROM identified_settlements
 UNION ALL SELECT operation_id FROM sync_journal_events UNION ALL SELECT operation_id FROM identified_journal_events
 UNION ALL SELECT operation_id FROM identified_tour_expenses UNION ALL SELECT operation_id FROM identified_tour_expense_revisions
 UNION ALL SELECT operation_id FROM identified_tour_expense_cancellations`);
 const operationIds=new Set<string>();for(const row of operations.rows){if(operationIds.has(row.operation_id))throw Error('Identifiant d’opération serveur ambigu.');operationIds.add(row.operation_id);}
 const clients=new Map(base.clients.map(c=>[c.id,c])),declared=new Set<string>();
 const payments=rows.rows.map(row=>{
  const payment=parseStoredDayInvoicePayment({operation_id:row.operationId,client_id:row.clientId,invoice_day:row.day,event_day:row.eventDay,payload:row.payload,payload_hash:row.hash});
  if(operationIds.has(payment.operationId))throw Error('Paiement serveur incohérent.');
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
/** Vérification isolée du premier choix de compensation déjà enregistré.
 * Elle ne débloque aucun ancien écran et ne prouve pas le paiement physique.
 * L'appelant doit fournir un instantané PostgreSQL REPEATABLE READ. */
async function readDayInvoiceCompensationProjectionInTransaction(db:PoolClient,operationId:string,reference:Awaited<ReturnType<typeof readUnprojectedDayInvoiceReference>>){
 const rows=await db.query(`SELECT c.operation_id,c.client_id,c.commercial_id,c.invoice_day::text AS invoice_day,c.event_day::text AS event_day,c.payload AS compensation,c.payload_hash AS compensation_hash,
  s.sale_id,s.version,s.client_id AS sale_client,s.commercial_id AS sale_commercial,s.journal_date::text AS sale_day,s.event_date::text AS sale_event_day,s.payload AS sale_event,s.payload_hash AS sale_hash
  FROM identified_day_invoice_compensations c JOIN identified_sale_events s ON s.operation_id=c.operation_id WHERE c.operation_id=$1`,[operationId]);
 if(rows.rows.length!==1)throw Error('Compensation introuvable.');
 const row=rows.rows[0],choice=compensationSchema.parse(row.compensation),event=saleEventSchema.parse(row.sale_event);
 const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 if(compensationHash(choice)!==row.compensation_hash||hash(event)!==row.sale_hash||event.operationId!==row.operation_id||event.saleId!==row.sale_id||event.sale.clientId!==row.client_id||row.sale_client!==row.client_id||row.sale_commercial!==row.commercial_id||row.sale_day!==row.invoice_day||row.sale_event_day!==row.event_day||event.version!==row.version||event.version<2||event.sale.syncVersion!==event.version||event.sale.syncSaleId!==event.saleId||event.refund!==0||tunisDay(event.sale.createdAt)!==row.invoice_day||tunisDay(event.recordedAt)!==row.event_day)throw Error('Preuve de compensation incohérente.');
 const previousRows=await db.query('SELECT payload,payload_hash,client_id,journal_date::text AS day FROM identified_sale_events WHERE sale_id=$1 AND version=$2',[event.saleId,event.version-1]);
 if(previousRows.rows.length!==1)throw Error('Version précédente indisponible : rapprochement requis.');
 const previousRow=previousRows.rows[0],previous=saleEventSchema.parse(previousRow.payload);
 if(hash(previous)!==previousRow.payload_hash||previous.saleId!==event.saleId||previous.version!==event.version-1||previous.sale.clientId!==row.client_id||previousRow.client_id!==row.client_id||previousRow.day!==row.invoice_day||previous.sale.createdAt!==event.sale.createdAt||previous.sale.paid!==event.sale.paid)throw Error('Version précédente incohérente.');
 const source=await readSourceForCompensationCheck(db,{clientId:row.client_id,day:row.invoice_day} as DayInvoicePayment,operationId,reference);
 const current=source.sales.find(s=>s.id===event.saleId);
 if(!current||current.version!==event.version||current.total!==event.sale.total||current.paid!==event.sale.paid)throw Error('Vente compensée modifiée.');
 const before={...source,sales:source.sales.map(s=>s.id===event.saleId?{...s,version:previous.version,total:previous.sale.total,paid:previous.sale.paid}:s)};
 const assessment=assessDayInvoiceSaleRevision(before,event.saleId,event.sale.total);
 if(!assessment.requiresChoice||assessment.excess!==choice.amount||assessment.previousTotal!==choice.previousTotal||assessment.paid!==choice.paid)throw Error('Montant de compensation incohérent.');
 const client=reference.clients.find(c=>c.id===row.client_id);
 if(!client||reference.dayPayments.some(p=>p.clientId===row.client_id&&p.day===row.invoice_day&&Date.parse(p.recordedAt)>Date.parse(event.recordedAt)))throw Error('Historique ou solde de compensation incohérent.');
 const balance=BigInt(client.serverBalance)+(choice.choice==='refund'?BigInt(choice.amount):0n),applied=BigInt(assessment.paid)-BigInt(choice.amount),remaining=BigInt(assessment.total)-applied;
 const safe=(n:bigint)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw RangeError('Montant trop élevé.');return Number(n);};
 if(applied<0n||remaining<0n)throw Error('Règlement après compensation incohérent.');
 return {operationId,clientId:row.client_id as string,commercialId:row.commercial_id as string,invoiceDay:row.invoice_day as string,eventDay:row.event_day as string,recordedAt:event.recordedAt,choice:choice.choice,compensation:choice.amount,total:assessment.total,paidBeforeCompensation:assessment.paid,applied:safe(applied),remaining:safe(remaining),balance:safe(balance),refund:choice.choice==='refund'?choice.amount:0,credit:choice.choice==='credit'?choice.amount:0};
}
/** Contrôle exhaustif des compensations indépendantes : un client ne peut
 * apparaître qu'une fois tant que le rejeu de plusieurs révisions n'existe pas. */
export async function readIndependentCompensationProjectionsInTransaction(db:PoolClient){
 const rows=await db.query('SELECT operation_id,client_id FROM identified_day_invoice_compensations ORDER BY operation_id LIMIT 1001');
 if(rows.rows.length>1000)throw Error('Trop de compensations pour un rapprochement complet.');
 const clients=new Set<string>(),result:Awaited<ReturnType<typeof readDayInvoiceCompensationProjectionInTransaction>>[]=[];
 for(const row of rows.rows){if(clients.has(row.client_id))throw Error('Compensations ambiguës pour ce client : historique complet requis.');clients.add(row.client_id);}
 // Même instantané de base pour tous les clients ; ne pas recharger les
 // articles et toute la référence une fois par compensation.
 if(!rows.rows.length)return result;
 const reference=await readUnprojectedDayInvoiceReference(db,true);
 for(const row of rows.rows){
  const projection=await readDayInvoiceCompensationProjectionInTransaction(db,row.operation_id,reference);
  if(projection.clientId!==row.client_id)throw Error('Client de compensation incohérent.');
  result.push(projection);
 }
 return result;
}
/** Photographie consolidée expérimentale après compensations indépendantes. Aucun
 * ancien lecteur ne doit consommer `reference` séparément : le paiement brut
 * dépasse désormais le total et la compensation est indispensable au calcul.
 * Ne l'exposer ni aux routes normales ni à la clôture avant migration complète. */
export async function readCompensatedDayInvoiceSnapshotInTransaction(db:PoolClient,operationId:string){
  const projections=await readIndependentCompensationProjectionsInTransaction(db),compensation=projections.find(p=>p.operationId===operationId);
  if(!compensation)throw Error('Compensation introuvable.');
  const reference=await readUnprojectedDayInvoiceReference(db,true);
  const client=reference.clients.find(c=>c.id===compensation.clientId);
  if(!client)throw Error('Client de compensation indisponible.');
  const balance=BigInt(client.serverBalance)+BigInt(compensation.refund);
  if(balance!==BigInt(compensation.balance))throw Error('Solde de compensation incohérent.');
  const invoices=reference.journalStates.filter(i=>i.clientId===compensation.clientId&&i.journalDate===compensation.invoiceDay);
  if(invoices.length>1)throw Error('Factures préétablies ambiguës.');
  const invoice=invoices[0],summary=invoice?summarizePreInvoice(invoice.total,invoice.receipts):null;
  const sales=reference.saleStates.filter(s=>s.clientId===compensation.clientId&&reference.saleDays.some(d=>d.saleId===s.saleId&&d.day===compensation.invoiceDay));
  const payments=reference.dayPayments.filter(p=>p.clientId===compensation.clientId&&p.day===compensation.invoiceDay).sort((a,b)=>a.recordedAt<b.recordedAt?-1:a.recordedAt>b.recordedAt?1:a.operationId<b.operationId?-1:a.operationId>b.operationId?1:0);
  const safe=(n:bigint)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw RangeError('Montant trop élevé.');return Number(n);};
  const salesTotal=sales.reduce((n,s)=>n+BigInt(s.total),0n),preInvoiceTotal=BigInt(invoice?.total??0);
  const paid=BigInt(summary?.prePaid??0)+sales.reduce((n,s)=>n+BigInt(s.paid),0n)+payments.reduce((n,p)=>n+BigInt(p.amount),0n);
  if(preInvoiceTotal+salesTotal!==BigInt(compensation.total)||paid!==BigInt(compensation.paidBeforeCompensation)||paid-BigInt(compensation.compensation)!==BigInt(compensation.applied))throw Error('Facture ou paiements de compensation incohérents.');
  const clients=reference.clients.map(c=>{
   const p=projections.find(item=>item.clientId===c.id);if(!p)return c;
   const corrected=BigInt(c.serverBalance)+BigInt(p.refund);
   if(corrected!==BigInt(p.balance))throw Error('Solde de compensation incohérent.');
   return {...c,serverBalance:String(corrected)};
  });
  if(projections.some(p=>!clients.some(c=>c.id===p.clientId)))throw Error('Client de compensation indisponible.');
  return {reference:{...reference,clients},compensation,invoice:{clientId:compensation.clientId,day:compensation.invoiceDay,preInvoiceTotal:safe(preInvoiceTotal),salesTotal:safe(salesTotal),total:compensation.total,paid:safe(paid),applied:compensation.applied,remaining:compensation.remaining,payments}};
}
export async function readCompensatedDayInvoiceSnapshot(pool:Pool,operationId:string){
 const db=await pool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));await assertOldCreditProtocolSafe(db);
  const result=await readCompensatedDayInvoiceSnapshotInTransaction(db,operationId);
  await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
/** Entrée interne de vérification, jamais reliée à une route ni à l'app active. */
export async function readDayInvoiceCompensationProjection(pool:Pool,operationId:string){
 const db=await pool.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));await assertOldCreditProtocolSafe(db);const projections=await readIndependentCompensationProjectionsInTransaction(db),projection=projections.find(p=>p.operationId===operationId);if(!projection)throw Error('Compensation introuvable.');await db.query('COMMIT');return projection;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
export async function readDayInvoiceReference(pool:Pool,includeInactive=false) {
 const db=await pool.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));await assertOldCreditProtocolSafe(db);const result=await readDayInvoiceReferenceInTransaction(db,includeInactive);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
