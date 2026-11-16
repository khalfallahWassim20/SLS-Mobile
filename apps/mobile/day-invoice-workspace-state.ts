/** Décision de reprise commune au futur espace facture du jour. Jamais de
 * nouvelle saisie avant lecture des quatre registres durables. */
import type {StoredPreinvoiceAttempt} from './day-invoice-preinvoice-attempt';
import type {StoredPaymentAttempt} from './day-invoice-payment-attempt';
import type {StoredOldDebtAttempt} from './day-invoice-old-debt-attempt';
import type {StoredSaleAttempt} from './day-invoice-sale-attempt-flow';
export type PendingDayWork={kind:'preinvoice'|'sale'|'payment'|'oldDebt';clientId:string;day:string};
export function pendingDayWork(input:{preinvoice:StoredPreinvoiceAttempt|null;sale:StoredSaleAttempt|null;payment:StoredPaymentAttempt|null;oldDebt:StoredOldDebtAttempt|null}):PendingDayWork|null{
 if(input.preinvoice)return {kind:'preinvoice',clientId:input.preinvoice.attempt.clientId,day:input.preinvoice.attempt.day};
 if(input.sale)return {kind:'sale',clientId:input.sale.attempt.clientId,day:input.sale.attempt.day};
 if(input.payment)return {kind:'payment',clientId:input.payment.attempt.clientId,day:input.payment.attempt.day};
 if(input.oldDebt)return {kind:'oldDebt',clientId:input.oldDebt.attempt.event.event.settlement.clientId,day:input.oldDebt.attempt.event.invoiceDay};
 return null;
}
