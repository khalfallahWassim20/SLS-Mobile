/** Lecture administrative distincte après compensation : jamais utilisée
 * pour clôturer, éditer ou attester le versement d'un remboursement. */
import type {Pool} from 'pg';
import {z} from 'zod';
import {journalDateSchema} from './journal-protocol.js';
import {lockSyncMode,assertIdentifiedMode} from './tour-sync-mode.js';
import {assertOldCreditProtocolSafe} from './credit-note-active-guards.js';
import {readCompensatedJournalDayInTransaction} from './identified-journal-day.js';
import {JournalConflict} from './journal-store.js';

export async function readAdminCompensatedDay(pool:Pool,commercialId:string,day:string){
 z.string().uuid().parse(commercialId);journalDateSchema.parse(day);
 const db=await pool.connect();try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));await assertOldCreditProtocolSafe(db);
  const first=await db.query('SELECT operation_id FROM identified_day_invoice_compensations ORDER BY operation_id LIMIT 1');
  if(!first.rows.length)throw new JournalConflict('Aucune compensation enregistrée : actualisez le journal.');
  const j=await readCompensatedJournalDayInTransaction(db,commercialId,day,first.rows[0].operation_id);
  const result={version:1 as const,day:j.day,commercial:{id:j.commercial.id,name:j.commercial.name},closure:{status:j.closure.status,version:j.closure.version},
   totalBilled:j.totalBilled,totalCollected:j.totalCollected,refund:j.compensationRefundTotal,credit:j.compensationCreditTotal,theoreticalNet:j.collectedAfterCompensationRefund,
   detailsVersion:1 as const,expenseTotal:j.expenseTotal,expenses:j.expenses,
   dayInvoicePayments:j.dayInvoicePayments.map(({operationId,clientId,recordedAt,amount,mode,chequeNumber,chequeBank,chequeDue})=>({operationId,clientId,recordedAt,amount,mode,chequeNumber,chequeBank,chequeDue})),
   oldDebtPayments:j.dayInvoiceOldDebtPayments.map(({operationId,clientId,recordedAt,amount,mode,chequeNumber,chequeBank,chequeDue})=>({operationId,clientId,recordedAt,amount,mode,chequeNumber,chequeBank,chequeDue})),
   rows:j.rows.map(r=>({clientId:r.clientId,clientName:r.clientName,sector:r.sector,preInvoiceTotal:r.preInvoiceTotal,salesTotal:r.tourTotal,totalClient:r.totalClient,dayInvoicePaid:r.dayInvoicePaid,oldDebtPaid:r.oldDebtPaid,totalCollected:r.totalCollected,refund:r.compensationRefund,credit:r.compensationCredit,theoreticalNet:r.afterCompensationRefund}))};
  await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
