/** Vue interne par commercial, limitée aux données identifiées et non exposée. */
import type {Pool,PoolClient} from 'pg';
import {assertNoUnprojectedCompensation} from './day-invoice-compensation.js';
import {readIndependentCompensationProjectionsInTransaction} from './day-invoice-reference.js';
import {z} from 'zod';
import {buildServerJournalDay} from './journal-day.js';
import {journalDateSchema,parseJournalSnapshot} from './journal-protocol.js';
import {lockSyncMode,assertIdentifiedMode} from './tour-sync-mode.js';
import {assertOldCreditProtocolSafe} from './credit-note-active-guards.js';
import {readDayInvoiceJournalPayments,readDayInvoiceDeclarations,readDayInvoiceJournalOldDebts} from './day-invoice-journal.js';

/** L'appelant doit fournir un instantané REPEATABLE READ ; cette fonction ne
 * vérifie pas le protocole et ne doit pas être utilisée seule par une route. */
export async function readIdentifiedJournalDayInTransaction(db:PoolClient,commercialId:string,day:string) {
 await assertNoUnprojectedCompensation(db);
 return readUnprojectedJournalDay(db,commercialId,day);
}
/** Lecture brute uniquement utilisable après vérification de la compensation. */
async function readUnprojectedJournalDay(db:PoolClient,commercialId:string,day:string) {
 z.string().uuid().parse(commercialId);journalDateSchema.parse(day);
  const commercial=await db.query('SELECT id,name FROM commercials WHERE id=$1 AND deleted_at IS NULL',[commercialId]);
  if(!commercial.rows.length)throw new RangeError('Commercial introuvable.');
  const invoices=await db.query(`SELECT DISTINCT ON (e.invoice_id) e.payload FROM identified_journal_events e
   JOIN identified_journal_invoices i ON i.id=e.invoice_id WHERE i.commercial_id=$1 AND i.journal_date=$2::date
   ORDER BY e.invoice_id,e.version DESC`,[commercialId,day]);
  // La vente reste dans le journal de son créateur, même modifiée par un autre commercial.
  const sales=await db.query(`WITH first AS (SELECT DISTINCT ON (sale_id) sale_id,commercial_id,journal_date FROM identified_sale_events WHERE version=1 ORDER BY sale_id,version ASC),
   latest AS (SELECT DISTINCT ON (sale_id) sale_id,payload FROM identified_sale_events ORDER BY sale_id,version DESC)
   SELECT l.sale_id AS "saleId",l.payload->'sale' AS sale FROM latest l JOIN first f ON f.sale_id=l.sale_id
   WHERE f.commercial_id=$1 AND f.journal_date=$2::date`,[commercialId,day]);
  const settlements=await db.query(`SELECT count(*)::int AS count,COALESCE(sum((payload->'settlement'->>'amount')::bigint),0)::text AS amount
   FROM identified_settlements WHERE commercial_id=$1 AND journal_date=$2::date`,[commercialId,day]);
  const expenses=await db.query(`SELECT e.operation_id AS "operationId",e.created_at AS "createdAt",COALESCE(r.description,e.description) AS description,COALESCE(r.amount,e.amount)::text AS amount,COALESCE(r.version,1) AS version FROM identified_tour_expenses e LEFT JOIN LATERAL (SELECT version,description,amount FROM identified_tour_expense_revisions WHERE expense_id=e.operation_id ORDER BY version DESC LIMIT 1) r ON true WHERE e.commercial_id=$1 AND e.journal_date=$2::date AND NOT EXISTS(SELECT 1 FROM identified_tour_expense_cancellations c WHERE c.expense_id=e.operation_id) ORDER BY e.created_at,e.operation_id`,[commercialId,day]);
  const expenseCancellations=await db.query(`SELECT c.operation_id AS "operationId",c.expense_id AS "expenseId",c.version,c.recorded_at AS "recordedAt",c.description,c.amount::text AS amount,c.reason FROM identified_tour_expense_cancellations c JOIN identified_tour_expenses e ON e.operation_id=c.expense_id WHERE e.commercial_id=$1 AND e.journal_date=$2::date ORDER BY c.recorded_at,c.operation_id`,[commercialId,day]);
  for(const c of expenseCancellations.rows)if(BigInt(c.amount)>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Montant de dépense trop élevé.');
  const expenseTotal=expenses.rows.reduce((n,e)=>n+BigInt(e.amount),0n);if(expenseTotal>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Total des dépenses trop élevé.');
  const expenseHistory=await db.query(`SELECT r.operation_id AS "operationId",r.expense_id AS "expenseId",r.version,r.recorded_at AS "recordedAt",r.previous_description AS "previousDescription",r.previous_amount::text AS "previousAmount",r.description,r.amount::text AS amount FROM identified_tour_expense_revisions r JOIN identified_tour_expenses e ON e.operation_id=r.expense_id WHERE e.commercial_id=$1 AND e.journal_date=$2::date ORDER BY r.recorded_at,r.operation_id`,[commercialId,day]);
  for(const r of expenseHistory.rows)if(BigInt(r.amount)>BigInt(Number.MAX_SAFE_INTEGER)||BigInt(r.previousAmount)>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Montant de dépense trop élevé.');
  const closure=await db.query(`SELECT status,version,closed_at FROM tour_closures WHERE commercial_id=$1 AND journal_date=$2::date`,[commercialId,day]);
  // La facture d'origine n'a pas d'auteur connu : ne pas l'attribuer à l'auteur d'un paiement ultérieur.
  const inherited=await db.query(`SELECT e.payload FROM identified_journal_events e JOIN identified_journal_invoices i ON i.id=e.invoice_id
   WHERE i.commercial_id IS NULL AND e.commercial_id=$1 AND i.journal_date=$2::date ORDER BY e.invoice_id,e.version`,[commercialId,day]);
  const inheritedByClient=new Map<string,{clientId:string;clientName:string;prePaid:bigint;oldDebtPaid:bigint}>();
  for(const row of inherited.rows){
   const event=parseJournalSnapshot(row.payload),receipt=event.receipts.at(-1);
   if(!receipt)throw new RangeError('Historique hérité de facture incomplet.');
   let item=inheritedByClient.get(event.invoice.clientId);
   if(!item){item={clientId:event.invoice.clientId,clientName:event.invoice.clientName,prePaid:0n,oldDebtPaid:0n};inheritedByClient.set(item.clientId,item);}
   item.prePaid+=BigInt(receipt.prePaid);item.oldDebtPaid+=BigInt(receipt.oldDebtPaid);
  }
  const inheritedTotal=[...inheritedByClient.values()].reduce((n,p)=>n+p.prePaid+p.oldDebtPaid,0n);

  const dayResult=buildServerJournalDay(day,invoices.rows.map(r=>r.payload),sales.rows.map(r=>({...r.sale,saleId:r.saleId})));
  const unified=await readDayInvoiceJournalPayments(db,commercialId,day);
  const oldDebt=await readDayInvoiceJournalOldDebts(db,commercialId,day);
  const declarations=await readDayInvoiceDeclarations(db,day,dayResult.rows.filter(row=>row.preInvoiceId).map(row=>row.clientId));
  // Un paiement peut porter sur une facture antérieure ou créée par un autre
  // commercial : il entre dans cette caisse sans s'attribuer le facturé.
  const amounts=new Map<string,bigint>();
  for(const payment of unified.payments)amounts.set(payment.clientId,(amounts.get(payment.clientId)??0n)+BigInt(payment.amount));
  const debtAmounts=new Map<string,bigint>();for(const payment of oldDebt.payments)debtAmounts.set(payment.clientId,(debtAmounts.get(payment.clientId)??0n)+BigInt(payment.amount));
  const safe=(n:bigint)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw new RangeError('Total encaissé trop élevé.');return Number(n);};
  const rows=dayResult.rows.map(row=>{
   const declaration=row.preInvoiceId?declarations.get(row.preInvoiceId):undefined;
   if(declaration&&(declaration.clientId!==row.clientId||declaration.total!==row.preInvoiceTotal||row.declared))throw Error('Déclaration de facture du jour incohérente.');
   return {...row,dayInvoicePaid:safe(amounts.get(row.clientId)??0n),dayInvoiceOldDebtPaid:safe(debtAmounts.get(row.clientId)??0n),oldDebtPaid:safe(BigInt(row.oldDebtPaid)+(debtAmounts.get(row.clientId)??0n)),totalCollected:safe(BigInt(row.totalCollected)+(amounts.get(row.clientId)??0n)+(debtAmounts.get(row.clientId)??0n)),declared:row.declared||!!declaration};
  });
  const rowClients=new Set(rows.map(row=>row.clientId));
  for(const payment of [...unified.payments,...oldDebt.payments])if(!rowClients.has(payment.clientId)){rowClients.add(payment.clientId);rows.push({clientId:payment.clientId,clientName:payment.clientName,sector:payment.sector,preInvoiceId:null,preInvoiceTotal:0,preInvoicePaid:0,oldDebtPaid:safe(debtAmounts.get(payment.clientId)??0n),preInvoiceRemaining:0,declared:false,tourTotal:0,tourPaid:0,saleCount:0,totalClient:0,totalCollected:safe((amounts.get(payment.clientId)??0n)+(debtAmounts.get(payment.clientId)??0n)),dayInvoicePaid:safe(amounts.get(payment.clientId)??0n),dayInvoiceOldDebtPaid:safe(debtAmounts.get(payment.clientId)??0n)});}
  rows.sort((a,b)=>a.clientName.localeCompare(b.clientName));
  const journalCollected=safe(BigInt(dayResult.totalCollected)+BigInt(unified.total));
  const total=BigInt(journalCollected)+BigInt(settlements.rows[0].amount)+inheritedTotal;
  if(total>BigInt(Number.MAX_SAFE_INTEGER)||total<BigInt(Number.MIN_SAFE_INTEGER))throw new RangeError('Total encaissé trop élevé.');
  const events=await db.query(`SELECT action,actor_id AS "actorId",actor_role AS "actorRole",occurred_at AS "occurredAt",version
   FROM tour_closure_events WHERE commercial_id=$1 AND journal_date=$2::date ORDER BY version DESC LIMIT 200`,[commercialId,day]);
  const inheritedPayments=[...inheritedByClient.values()].map(p=>{if(p.prePaid>BigInt(Number.MAX_SAFE_INTEGER)||p.oldDebtPaid>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Total encaissé trop élevé.');return {clientId:p.clientId,clientName:p.clientName,prePaid:Number(p.prePaid),oldDebtPaid:Number(p.oldDebtPaid)};});
  const state=closure.rows[0];
  return {...dayResult,rows,clientCount:rows.length,dayInvoicePayments:unified.payments,dayInvoiceTotal:unified.total,dayInvoiceOldDebtPayments:oldDebt.payments,dayInvoiceOldDebtTotal:oldDebt.total,commercial:commercial.rows[0],closure:{status:state?.status??'open',version:state?.version??0,closedAt:state?.closed_at?new Date(state.closed_at).toISOString():null},
   journalCollected,inheritedJournalPayments:inheritedPayments,inheritedJournalTotal:Number(inheritedTotal),globalSettlementCount:settlements.rows[0].count,globalSettlementTotal:Number(settlements.rows[0].amount),totalCollected:Number(total),expenseTotal:Number(expenseTotal),expenses:expenses.rows.map(e=>({operationId:e.operationId,createdAt:new Date(e.createdAt).toISOString(),description:e.description,amount:Number(e.amount),version:e.version})),expenseHistory:expenseHistory.rows.map(r=>({...r,recordedAt:new Date(r.recordedAt).toISOString(),previousAmount:Number(r.previousAmount),amount:Number(r.amount)})),expenseCancellations:expenseCancellations.rows.map(c=>({...c,recordedAt:new Date(c.recordedAt).toISOString(),amount:Number(c.amount)})),closureEvents:events.rows};
}
/** Projection interne des compensations indépendantes prouvées. Ne valide ni
 * clôture ni versement physique ; chaque choix appartient au jour et au
 * commercial qui l'a enregistré. */
export async function readCompensatedJournalDayInTransaction(db:PoolClient,commercialId:string,day:string,operationId:string){
 z.string().uuid().parse(commercialId);z.string().uuid().parse(operationId);journalDateSchema.parse(day);
 const projections=await readIndependentCompensationProjectionsInTransaction(db);
 if(!projections.some(p=>p.operationId===operationId))throw Error('Compensation introuvable.');
 const journal=await readUnprojectedJournalDay(db,commercialId,day),own=projections.filter(p=>p.commercialId===commercialId&&p.eventDay===day);
 const safe=(n:bigint)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw RangeError('Total encaissé trop élevé.');return Number(n);};
 const refund=safe(own.reduce((n,p)=>n+BigInt(p.refund),0n)),credit=safe(own.reduce((n,p)=>n+BigInt(p.credit),0n));
 const net=safe(BigInt(journal.totalCollected)-BigInt(refund)),byClient=new Map(own.map(p=>[p.clientId,p]));
 const rows=journal.rows.map(row=>{const p=byClient.get(row.clientId),ref=p?.refund??0;return {...row,compensationRefund:ref,compensationCredit:p?.credit??0,afterCompensationRefund:safe(BigInt(row.totalCollected)-BigInt(ref))};});
 for(const projection of own)if(!rows.some(row=>row.clientId===projection.clientId)){
  const result=await db.query('SELECT name,sector FROM clients WHERE id=$1 AND deleted_at IS NULL',[projection.clientId]);const client=result.rows[0];if(!client||typeof client.name!=='string'||typeof client.sector!=='string')throw Error('Client de compensation indisponible.');
  rows.push({clientId:projection.clientId,clientName:client.name,sector:client.sector,preInvoiceId:null,preInvoiceTotal:0,preInvoicePaid:0,oldDebtPaid:0,preInvoiceRemaining:0,declared:false,tourTotal:0,tourPaid:0,saleCount:0,totalClient:0,totalCollected:0,dayInvoicePaid:0,dayInvoiceOldDebtPaid:0,compensationRefund:projection.refund,compensationCredit:projection.credit,afterCompensationRefund:safe(-BigInt(projection.refund))});
 }
 rows.sort((a,b)=>a.clientName.localeCompare(b.clientName));
 return {...journal,rows,clientCount:rows.length,compensationEvents:own,compensationRefundTotal:refund,compensationCreditTotal:credit,collectedAfterCompensationRefund:net};
}
export async function readCompensatedJournalDay(pool:Pool,commercialId:string,day:string,operationId:string){
 const db=await pool.connect();try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));await assertOldCreditProtocolSafe(db);
  const result=await readCompensatedJournalDayInTransaction(db,commercialId,day,operationId);
  await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
export async function readIdentifiedJournalDay(pool:Pool,commercialId:string,day:string,enforceMode=false) {
 const db=await pool.connect();
 try {
  await db.query(enforceMode?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  if(enforceMode)assertIdentifiedMode(await lockSyncMode(db));
  await assertOldCreditProtocolSafe(db);
  const result=await readIdentifiedJournalDayInTransaction(db,commercialId,day);
  await db.query('COMMIT');return result;
 } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
