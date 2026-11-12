/** Modèle d'affichage du futur écran d'avoir ; aucun calcul de solde de
 * l'application courante n'utilise cette fonction. */
import {calculateFullCancellation,calculatePreInvoiceCancellation,summarizePreInvoice} from '@sls/domain';
import type {CreditReview} from './credit-note-review-prototype';
import {tunisDay} from './journal';
export function describeCreditReview(review:CreditReview){
 if(!review||!review.source||typeof review.source!=='object'||Array.isArray(review.source))throw Error('Aperçu d’avoir invalide.');
 const source=review.source as Record<string,any>;
 let clientName:string,invoiceTotal:number,paid:number,oldDebtPaid:number,invoiceDay:string;
 let calculated:{balanceAfter:number;refund:number;retainedCredit:number};
 if(review.kind==='sale'){
  if(source.syncSaleId!==review.invoiceId||source.syncVersion!==review.expectedVersion||source.clientId!==review.clientId)throw Error('Vente de l’aperçu incohérente.');
  clientName=source.clientName;invoiceTotal=source.total;paid=source.paid;oldDebtPaid=0;
  const date=new Date(source.createdAt);if(!Number.isFinite(date.getTime()))throw Error('Date de vente invalide.');invoiceDay=tunisDay(date);
  calculated=calculateFullCancellation({balance:review.beforeBalance,invoiceTotal,invoiceNetPaid:paid,alreadyCancelled:false,choice:review.choice??undefined});
 } else if(review.kind==='preinvoice'){
  const invoice=source.invoice;
  if(!invoice||invoice.id!==review.invoiceId||invoice.clientId!==review.clientId||source.version!==review.expectedVersion||!Array.isArray(source.receipts))throw Error('Préétablie de l’aperçu incohérente.');
  clientName=invoice.clientName;invoiceTotal=invoice.amount;invoiceDay=invoice.journalDate;
  const summary=summarizePreInvoice(invoiceTotal,source.receipts);paid=summary.prePaid;oldDebtPaid=summary.oldDebtPaid;
  calculated=calculatePreInvoiceCancellation({balance:review.beforeBalance,invoiceTotal,receipts:source.receipts,alreadyCancelled:false,choice:review.choice??undefined});
 }else throw Error('Type de facture invalide.');
 if(typeof clientName!=='string'||!clientName.trim()||typeof invoiceDay!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDay)||calculated.balanceAfter!==review.afterBalance||calculated.refund!==review.refund||calculated.retainedCredit!==review.retainedCredit||BigInt(review.afterBalance)-BigInt(review.beforeBalance)!==BigInt(review.balanceDelta))throw Error('Aperçu d’avoir incohérent.');
 return {kind:review.kind,clientName,invoiceTotal,paid,oldDebtPaid,invoiceDay,choice:review.choice,beforeBalance:review.beforeBalance,afterBalance:review.afterBalance,refund:review.refund,retainedCredit:review.retainedCredit};
}
