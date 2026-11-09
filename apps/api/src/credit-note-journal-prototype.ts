/** Journal avec avoirs en vue isolée. Ne pas exposer tant que les écrans,
 * synchronisations et anciens clients ne sont pas migrés ensemble. */
import type {Pool} from 'pg';
import {readIdentifiedJournalDayInTransaction} from './identified-journal-day.js';
import {readPrototypeCreditHistoryInTransaction} from './credit-note-history-prototype.js';
import {assertIdentifiedMode,lockSyncMode} from './tour-sync-mode.js';
const safe=(n:bigint)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw new RangeError('Total du journal trop élevé.');return Number(n);};
/** L'avoir affecte le jour de sa création, même lorsque la facture est plus
 * ancienne. Les totaux bruts et les paiements d'ancienne dette sont conservés.
 * Cette vue n'est pas un chiffre d'affaires consolidé. */
export async function readPrototypeCreditJournal(pool:Pool,commercialId:string,day:string) {
 const db=await pool.connect();
 try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));
  const base=await readIdentifiedJournalDayInTransaction(db,commercialId,day);
  const history=await readPrototypeCreditHistoryInTransaction(db);
  const owned=history.filter(h=>h.ownerId===commercialId),events=owned.filter(h=>h.recordedDay===day);
  const billed=events.reduce((n,e)=>n+BigInt(e.invoiceTotal),0n),refund=events.reduce((n,e)=>n+BigInt(e.refund),0n),credit=events.reduce((n,e)=>n+BigInt(e.retainedCredit),0n);
  const rows=base.rows.map(row=>{
   const invoices=owned.filter(h=>h.invoiceDay===day&&h.clientId===row.clientId);
   return {...row,preInvoiceCancelled:!!row.preInvoiceId&&invoices.some(e=>e.kind==='preinvoice'&&e.invoiceId===row.preInvoiceId),cancelledSaleCount:invoices.filter(e=>e.kind==='sale').length};
  });
  const result={...base,rows,creditVersion:5 as const,creditEvents:events,creditNoteTotal:safe(billed),creditRefundTotal:safe(refund),creditRetainedTotal:safe(credit),billedAfterCredits:safe(BigInt(base.totalBilled)-billed),collectedAfterRefunds:safe(BigInt(base.totalCollected)-refund)};
  await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
