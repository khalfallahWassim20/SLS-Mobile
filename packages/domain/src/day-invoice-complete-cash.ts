/** Format préparatoire de preuve de caisse avec dépenses. Ne valide pas une
 * clôture, les compensations ou les opérations d'autres appareils hors ligne. */
import {canonicalJson} from './canonical-json.ts';
import {dayInvoiceCashClosureCanonical} from './day-invoice-cash.ts';
import {expenseClosureCanonical,type ExpenseProofSnapshot} from './day-invoice-expense-proof.ts';

export function dayInvoiceCashWithExpensesCanonical(sales:unknown,journal:unknown,dayPayments:unknown,commercialId:string,day:string,ownerDeclarations:unknown,expenses:unknown):string {
 const cash=JSON.parse(dayInvoiceCashClosureCanonical(sales,journal,dayPayments,commercialId,day,ownerDeclarations));
 const expense=JSON.parse(expenseClosureCanonical(expenses,commercialId,day));
 const ids=new Set<string>();
 const add=(id:string)=>{const key=id.toLowerCase();if(ids.has(key))throw Error('Identifiant commun à plusieurs mouvements de caisse.');ids.add(key);};
 for(const e of [...cash.legacy.initial,...cash.legacy.refunds,...cash.legacy.journalEvents,...cash.dayPayments])add(e.operationId);
 // Une déclaration peut être aussi un paiement de caisse, ce qui a déjà été
 // validé par dayInvoiceCashClosureCanonical. Elle doit néanmoins être
 // réservée contre les identifiants des dépenses.
 for(const e of cash.ownerDeclarations)ids.add(e.operationId.toLowerCase());
 for(const e of (expense.expenses as ExpenseProofSnapshot['expenses'])){
  add(e.operationId);for(const r of e.revisions)add(r.operationId);if(e.cancellation)add(e.cancellation.operationId);
 }
 return canonicalJson({protocol:'sls-cash-close-with-expenses-v1',commercialId,day,cash,expenses:expense});
}
