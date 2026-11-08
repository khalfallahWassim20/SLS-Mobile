import {summarizePreInvoice,type PreInvoiceReceipt} from './journal.ts';
import type {FullCreditChoice} from './credit-note.ts';

/** Calcul préparatoire uniquement. La facture préétablie existe dans un système
 * externe : l'annulation ici n'annule ni ne corrige ce système. Les paiements
 * de dette ancienne ne sont jamais assimilés à ceux de la facture annulée. */
export function calculatePreInvoiceCancellation(input:{balance:number;invoiceTotal:number;receipts:PreInvoiceReceipt[];alreadyCancelled:boolean;choice?:FullCreditChoice}) {
 if(!Number.isSafeInteger(input.balance))throw new RangeError('Solde invalide');
 if(typeof input.alreadyCancelled!=='boolean')throw new RangeError('État de la facture invalide');
 if(input.alreadyCancelled)throw new RangeError('Facture déjà annulée');
 if(!Array.isArray(input.receipts))throw new RangeError('Règlements invalides');
 if(input.choice!==undefined&&input.choice!=='refund'&&input.choice!=='credit')throw new RangeError('Choix de remboursement invalide');
 const before=summarizePreInvoice(input.invoiceTotal,input.receipts);
 if(before.prePaid>0&&!input.choice)throw new RangeError('Choisissez le remboursement ou le crédit client');
 if(before.prePaid===0&&input.choice!==undefined)throw new RangeError('Aucun paiement de facture à rembourser ou conserver en crédit');
 const refund=input.choice==='refund'?before.prePaid:0;
 const retainedCredit=input.choice==='credit'?before.prePaid:0;
 // La facture non déclarée n'a encore aucun effet sur le solde. Sinon elle
 // contribue à hauteur du reste impayé. Les règlements d'ancienne dette restent.
 const oldInvoiceContribution=before.declared ? BigInt(before.remaining) : 0n;
 const delta=-oldInvoiceContribution-BigInt(retainedCredit);
 const after=BigInt(input.balance)+delta;
 if(after<BigInt(Number.MIN_SAFE_INTEGER)||after>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Solde trop élevé');
 return {creditNoteTotal:input.invoiceTotal,invoicePaid:before.prePaid,oldDebtPaid:before.oldDebtPaid,refund,retainedCredit,balanceDelta:Number(delta),balanceAfter:Number(after),wasDeclared:before.declared};
}
