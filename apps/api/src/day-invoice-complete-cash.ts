/** Preuve préparatoire de caisse avec dépenses, sans clôture ni mutation.
 * L'appelant doit détenir les verrous de mode et de journée dans la même
 * transaction jusqu'à sa décision. Les compensations restent interdites. */
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {dayInvoiceCashWithExpensesCanonical} from '../../../packages/domain/src/day-invoice-complete-cash.js';
import {assertOldCreditProtocolSafe} from './credit-note-active-guards.js';
import {assertDayInvoiceCloseRegistry} from './day-invoice-legacy-guard.js';
import {readSaleCashPreview} from './sale-cash-preview-prototype.js';
import {readJournalCashReconciliation} from './journal-cash-reconciliation-prototype.js';
import {readServerDayInvoiceCash} from './day-invoice-cash.js';
import {readDayInvoiceOwnerDeclarations} from './day-invoice-journal.js';
import {readExpenseClosureProofInTransaction} from './tour-expense-snapshot.js';
import {JournalConflict} from './journal-store.js';

export async function readCompleteDayInvoiceCashProofInTransaction(db:PoolClient,commercialId:string,day:string){
 await assertOldCreditProtocolSafe(db);await assertDayInvoiceCloseRegistry(db);
 const sale=await readSaleCashPreview(db,commercialId,day);
 if(!sale.available)throw new JournalConflict(`Rapprochement des ventes impossible : ${sale.reason}`);
 const sales={version:5 as const,commercialId,day,initialEvents:sale.initialEvents,refundEvents:sale.refundEvents.map(({operationId,saleId,clientId,recordedAt,refund})=>({operationId,saleId,clientId,recordedAt,refund})),saleStates:sale.entries.filter(e=>sale.initialEvents.some(p=>p.saleId===e.saleId)).map(({saleId,clientId,version,total,paid})=>({saleId,clientId,version,total,paid}))};
 const journal=await readJournalCashReconciliation(db,commercialId,day),payments=await readServerDayInvoiceCash(db,commercialId,day),declarations=await readDayInvoiceOwnerDeclarations(db,commercialId,day),expenses=await readExpenseClosureProofInTransaction(db,commercialId,day);
 const canonical=dayInvoiceCashWithExpensesCanonical(sales,journal,payments,commercialId,day,declarations,expenses.snapshot);
 return {canonical,hash:createHash('sha256').update(canonical).digest('hex')};
}
