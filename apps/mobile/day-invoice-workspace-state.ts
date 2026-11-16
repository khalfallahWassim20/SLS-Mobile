/** Décision de reprise commune au futur espace facture du jour. Jamais de
 * nouvelle saisie avant lecture des cinq registres durables. */
import type {StoredPreinvoiceAttempt} from './day-invoice-preinvoice-attempt';
import type {StoredPaymentAttempt} from './day-invoice-payment-attempt';
import type {StoredOldDebtAttempt} from './day-invoice-old-debt-attempt';
import type {StoredSaleEditAttempt} from './day-invoice-sale-edit-attempt';
import type {StoredSaleAttempt} from './day-invoice-sale-attempt-flow';
export type PendingDayWork={kind:'preinvoice'|'sale'|'payment'|'oldDebt'|'saleEdit';clientId:string;day:string;saleId?:number};
export type DayWorkAttempts={preinvoice:StoredPreinvoiceAttempt|null;sale:StoredSaleAttempt|null;saleEdit:StoredSaleEditAttempt|null;payment:StoredPaymentAttempt|null;oldDebt:StoredOldDebtAttempt|null};
export function pendingDayWork(input:DayWorkAttempts):PendingDayWork|null{
 if(input.preinvoice)return {kind:'preinvoice',clientId:input.preinvoice.attempt.clientId,day:input.preinvoice.attempt.day};
 if(input.sale)return {kind:'sale',clientId:input.sale.attempt.clientId,day:input.sale.attempt.day};
 if(input.saleEdit)return {kind:'saleEdit',clientId:input.saleEdit.attempt.clientId,day:input.saleEdit.attempt.day,saleId:input.saleEdit.attempt.saleId};
 if(input.payment)return {kind:'payment',clientId:input.payment.attempt.clientId,day:input.payment.attempt.day};
 if(input.oldDebt)return {kind:'oldDebt',clientId:input.oldDebt.attempt.event.event.settlement.clientId,day:input.oldDebt.attempt.event.invoiceDay};
 return null;
}

/** À appeler dans une seule transaction : une erreur de lecture ne doit jamais
 * être interprétée comme un registre vide ni exposer une nouvelle saisie. */
export async function captureWorkspaceState<T>(read:{preinvoice:()=>Promise<DayWorkAttempts['preinvoice']>;sale:()=>Promise<DayWorkAttempts['sale']>;saleEdit:()=>Promise<DayWorkAttempts['saleEdit']>;payment:()=>Promise<DayWorkAttempts['payment']>;oldDebt:()=>Promise<DayWorkAttempts['oldDebt']>;clients:()=>Promise<T>}):Promise<{pending:PendingDayWork;clients:null}|{pending:null;clients:T}>{
 const preinvoice=await read.preinvoice(),sale=await read.sale(),saleEdit=await read.saleEdit(),payment=await read.payment(),oldDebt=await read.oldDebt();
 const pending=pendingDayWork({preinvoice,sale,saleEdit,payment,oldDebt});
 return pending?{pending,clients:null}:{pending:null,clients:await read.clients()};
}
