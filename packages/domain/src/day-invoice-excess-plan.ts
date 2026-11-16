/** Simulation métier isolée du trop-perçu après révision. Aucune écriture,
 * aucun paiement ni remboursement effectif ; non raccordée au protocole v6.
 * Montants en millimes, solde positif = dette, négatif = crédit client. */
import {assessDayInvoiceSaleRevision,type DayInvoiceInput} from './day-invoice.ts';
export type DayInvoiceExcessChoice='refund'|'credit';
function signed(value:bigint):number{
 if(value>BigInt(Number.MAX_SAFE_INTEGER)||value<BigInt(Number.MIN_SAFE_INTEGER))throw new RangeError('Solde trop élevé');
 return Number(value);
}
/** Une seule première révision à partir d'une facture non surpayée. Ne pas
 * employer ce calcul pour rejouer des remboursements ou crédits déjà attribués :
 * leur historique et leur utilisation nécessitent un protocole dédié. */
export function planDayInvoiceSaleExcess(input:DayInvoiceInput,saleId:string,newSaleTotal:number,balanceBefore:number){
 if(!Number.isSafeInteger(balanceBefore))throw new RangeError('Solde client invalide');
 const assessment=assessDayInvoiceSaleRevision(input,saleId,newSaleTotal);
 if(assessment.paid>assessment.previousTotal)throw new RangeError('Facture déjà surpayée : historique de compensation requis');
 const base=BigInt(balanceBefore)+BigInt(assessment.balanceDelta),excess=BigInt(assessment.excess);
 const option=(choice:DayInvoiceExcessChoice|null)=>({choice,refundAmount:choice==='refund'?assessment.excess:0,creditAmount:choice==='credit'?assessment.excess:0,balanceAfter:signed(base+(choice==='refund'?excess:0n))});
 return {...assessment,balanceBefore,options:assessment.requiresChoice?[option('refund'),option('credit')]:[option(null)]};
}
/** Accepter explicitement un seul des choix présentés ; un aperçu ne vaut pas
 * confirmation et doit être recapturé sous verrou avant toute écriture. */
export function selectDayInvoiceExcessPlan(input:DayInvoiceInput,saleId:string,newSaleTotal:number,balanceBefore:number,choice:DayInvoiceExcessChoice|null){
 const plan=planDayInvoiceSaleExcess(input,saleId,newSaleTotal,balanceBefore);
 const selected=plan.options.find(option=>option.choice===choice);if(!selected)throw new RangeError('Choix de remboursement ou crédit invalide');
 return {...plan,selected};
}
