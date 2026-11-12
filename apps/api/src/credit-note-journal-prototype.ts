/** Journal avec avoirs en vue isolée. Ne pas exposer tant que les écrans,
 * synchronisations et anciens clients ne sont pas migrés ensemble. */
import type {Pool} from 'pg';
import {readIdentifiedJournalDayInTransaction} from './identified-journal-day.js';
import {readPrototypeCreditHistoryInTransaction} from './credit-note-history-prototype.js';
import {assertIdentifiedMode,lockSyncMode} from './tour-sync-mode.js';
import {readSaleCashPreview} from './sale-cash-preview-prototype.js';
import {JournalConflict} from './journal-store.js';
const safe=(n:bigint)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw new RangeError('Total du journal trop élevé.');return Number(n);};
/** L'avoir affecte le jour de sa création, même lorsque la facture est plus
 * ancienne. Les totaux bruts et les paiements d'ancienne dette sont conservés.
 * Cette vue n'est pas un chiffre d'affaires consolidé. */
export async function readPrototypeCreditJournal(pool:Pool,commercialId:string,day:string) {
 const db=await pool.connect();
 try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));
  const base=await readIdentifiedJournalDayInTransaction(db,commercialId,day);
  let cash:Awaited<ReturnType<typeof readSaleCashPreview>>;
  try{cash=await readSaleCashPreview(db,commercialId,day);}catch(e){if(e instanceof RangeError)throw new JournalConflict('Historique de vente incohérent : journal refusé.');throw e;}
  if(!cash.available)throw new JournalConflict(`Journal indisponible : ${cash.reason}`);
  const byClient=new Map<string,bigint>();
  for(const e of cash.entries)if(e.receivedHere)byClient.set(e.clientId,(byClient.get(e.clientId)??0n)+BigInt(e.receivedHere));
  const history=await readPrototypeCreditHistoryInTransaction(db);
  const owned=history.filter(h=>h.ownerId===commercialId),events=owned.filter(h=>h.recordedDay===day);
  const billed=events.reduce((n,e)=>n+BigInt(e.invoiceTotal),0n),refund=events.reduce((n,e)=>n+BigInt(e.refund),0n),credit=events.reduce((n,e)=>n+BigInt(e.retainedCredit),0n);
  const rows=base.rows.map(row=>{
   const invoices=owned.filter(h=>h.invoiceDay===day&&h.clientId===row.clientId);
   const tourPaid=safe(byClient.get(row.clientId)??0n);
   byClient.delete(row.clientId);
   return {...row,tourPaid,totalCollected:safe(BigInt(row.preInvoicePaid)+BigInt(row.oldDebtPaid)+BigInt(tourPaid)),preInvoiceCancelled:!!row.preInvoiceId&&invoices.some(e=>e.kind==='preinvoice'&&e.invoiceId===row.preInvoiceId),cancelledSaleCount:invoices.filter(e=>e.kind==='sale').length};
  });
  if(byClient.size)throw new JournalConflict('Paiement de vente sans client dans le journal.');
  const journalCollected=safe(rows.reduce((n,row)=>n+BigInt(row.totalCollected),0n));
  const totalCollected=safe(BigInt(journalCollected)+BigInt(base.inheritedJournalTotal)+BigInt(base.globalSettlementTotal));
  const result={...base,rows,journalCollected,totalCollected,saleRefundEvents:cash.refundEvents,saleRefundTotal:cash.refund,creditVersion:5 as const,creditEvents:events,creditNoteTotal:safe(billed),creditRefundTotal:safe(refund),creditRetainedTotal:safe(credit),billedAfterCredits:safe(BigInt(base.totalBilled)-billed),collectedAfterRefunds:safe(BigInt(totalCollected)-refund-BigInt(cash.refund))};
  await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
