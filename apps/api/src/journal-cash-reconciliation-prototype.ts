/** Instantané consultatif v5. Exclut les ventes (comparées séparément) et
 * ne démontre ni les données encore hors ligne ni les versements physiques. */
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {validateCashReconciliation,type CashReconciliationEntry} from '@sls/domain';
import {parseJournalSnapshot,journalSnapshotHash,validateJournalTransition,journalDateSchema,type JournalSnapshot} from './journal-protocol.js';
import {settlementSchema} from './identified-operations.js';
import {readPrototypeCreditHistoryInTransaction} from './credit-note-history-prototype.js';
import {JournalConflict} from './journal-store.js';
const dayOf=(s:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(s));
export async function readJournalCashReconciliation(db:PoolClient,commercialId:string,day:string){
 journalDateSchema.parse(day);const events:CashReconciliationEntry[]=[];
 const invoices=await db.query(`SELECT id,client_id,commercial_id,journal_date::text AS day FROM identified_journal_invoices WHERE journal_date=$1::date AND (commercial_id=$2 OR (commercial_id IS NULL AND EXISTS(SELECT 1 FROM identified_journal_events e WHERE e.invoice_id=identified_journal_invoices.id AND e.commercial_id=$2))) ORDER BY id LIMIT 1001`,[day,commercialId]);
 if(invoices.rows.length>1000)throw new JournalConflict('Plus de 1 000 préétablies : comparaison incomplète refusée.');
 for(const invoice of invoices.rows){
  if(invoice.commercial_id===null)throw new JournalConflict('Facture héritée sans propriétaire : rapprochement manuel nécessaire.');
  const rows=await db.query('SELECT operation_id,version,commercial_id,payload,payload_hash FROM identified_journal_events WHERE invoice_id=$1 ORDER BY version LIMIT 1002',[invoice.id]);
  if(!rows.rows.length||rows.rows.length>1001)throw new JournalConflict('Historique de préétablie incomplet ou trop long.');
  let previous:JournalSnapshot|null=null;
  for(const row of rows.rows){
   const current=parseJournalSnapshot(row.payload);
   if(current.operationId!==row.operation_id||current.version!==row.version||row.commercial_id!==commercialId||current.invoice.id!==invoice.id||current.invoice.clientId!==invoice.client_id||current.invoice.journalDate!==invoice.day||journalSnapshotHash(current)!==row.payload_hash)throw new RangeError('Historique de préétablie incohérent.');
   validateJournalTransition(previous,current);
   if(!previous){if(current.receipts.length)throw new RangeError('Historique initial de préétablie incohérent.');const p=current.invoice;events.push({kind:'invoice',operationId:current.operationId,invoiceId:p.id,clientId:p.clientId,recordedAt:p.createdAt,amount:p.amount});}
   else {const p=current.receipts.at(-1)!;events.push({kind:'receipt',operationId:current.operationId,invoiceId:p.preInvoiceId,receiptId:p.id,clientId:p.clientId,recordedAt:p.createdAt,prePaid:p.prePaid,oldDebtPaid:p.oldDebtPaid,creditFull:p.creditFull,mode:p.mode,chequeNumber:p.chequeNumber,chequeBank:p.chequeBank,chequeDue:p.chequeDue});}
   previous=current;
  }
 }
 const payments=await db.query(`SELECT operation_id,client_id,journal_date::text AS day,payload,payload_hash FROM identified_settlements WHERE commercial_id=$1 AND journal_date=$2::date ORDER BY operation_id LIMIT 20001`,[commercialId,day]);
 if(payments.rows.length>20000)throw new JournalConflict('Trop de règlements : comparaison incomplète refusée.');
 for(const row of payments.rows){const parsed=settlementSchema.parse(row.payload),p=parsed.settlement;
  if(parsed.operationId!==row.operation_id||p.syncOperationId!==row.operation_id||p.clientId!==row.client_id||row.day!==day||dayOf(p.createdAt)!==day||createHash('sha256').update(JSON.stringify(parsed)).digest('hex')!==row.payload_hash)throw new RangeError('Règlement de dette incohérent.');
  events.push({kind:'settlement',operationId:parsed.operationId,clientId:p.clientId,recordedAt:p.createdAt,amount:p.amount,mode:p.mode,chequeNumber:p.chequeNumber,chequeBank:p.chequeBank,chequeDue:p.chequeDue});
 }
 const history=await readPrototypeCreditHistoryInTransaction(db);
 for(const h of history.filter(h=>h.recordedDay===day)){
  if(h.ownerId===commercialId)events.push({kind:'owner-credit',operationId:h.operationId,clientId:h.clientId,recordedAt:h.recordedAt,invoiceId:h.invoiceId,invoiceKind:h.kind,invoiceTotal:h.invoiceTotal,refund:h.refund,retainedCredit:h.retainedCredit});
  if(h.actor.role==='commercial'&&h.actor.id===commercialId)events.push({kind:'credit',operationId:h.operationId,clientId:h.clientId,recordedAt:h.recordedAt,invoiceId:h.invoiceId,invoiceKind:h.kind,invoiceTotal:h.invoiceTotal,refund:h.refund,retainedCredit:h.retainedCredit});
  if(h.actor.role==='admin'&&h.refund>0&&h.cashAssignment?.commercialId===commercialId)events.push({kind:'admin-refund',operationId:h.operationId,clientId:h.clientId,recordedAt:h.recordedAt,invoiceId:h.invoiceId,invoiceKind:h.kind,assignmentId:h.cashAssignment.requestId,refund:h.refund});
 }
 const result={version:5 as const,commercialId,day,events};validateCashReconciliation(result,commercialId,day);return result;
}
