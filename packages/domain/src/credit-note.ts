/** Calcul préparatoire d'un avoir intégral. Montants entiers en millimes.
 * Fonction pure : elle ne crée ni document, ni mouvement, ni droit d'accès. */
export type FullCreditChoice = 'refund' | 'credit';
export type FullCancellationInput = {
 balance:number;
 invoiceTotal:number;
 /** Paiement net conservé sur cette vente, après remboursements déjà réalisés. */
 invoiceNetPaid:number;
 alreadyCancelled:boolean;
 choice?:FullCreditChoice;
};
function integer(value:number,label:string,min=0) {
 if(!Number.isSafeInteger(value)||value<min)throw new RangeError(`${label} invalide`);
}
function safe(value:bigint):number {
 if(value<BigInt(Number.MIN_SAFE_INTEGER)||value>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Solde trop élevé');
 return Number(value);
}
/** Le solde initial contient déjà la contribution (total - paiement net) de la vente.
 * Le crédit éventuel est conservé dans le solde global ; il n'est pas automatiquement
 * imputé à une autre facture. Un remboursement correspond à une sortie d'argent réelle. */
export function calculateFullCancellation(input:FullCancellationInput) {
 integer(input.balance,'Solde',Number.MIN_SAFE_INTEGER);
 integer(input.invoiceTotal,'Total de la facture');
 integer(input.invoiceNetPaid,'Paiement net');
 if(typeof input.alreadyCancelled!=='boolean')throw new RangeError('État de la facture invalide');
 if(input.alreadyCancelled)throw new RangeError('Facture déjà annulée');
 if(input.choice!==undefined && input.choice!=='refund' && input.choice!=='credit')throw new RangeError('Choix de remboursement invalide');
 if(input.invoiceNetPaid>0 && !input.choice)throw new RangeError('Choisissez le remboursement ou le crédit client');
 if(input.invoiceNetPaid===0 && input.choice!==undefined)throw new RangeError('Aucun paiement à rembourser ou conserver en crédit');
 const refund=input.choice==='refund'?input.invoiceNetPaid:0;
 const retainedCredit=input.choice==='credit'?input.invoiceNetPaid:0;
 // Retirer l'effet de la facture initiale puis appliquer l'effet de la vente annulée.
 const oldContribution=BigInt(input.invoiceTotal)-BigInt(input.invoiceNetPaid);
 const newContribution=-BigInt(retainedCredit);
 return {creditNoteTotal:input.invoiceTotal,refund,retainedCredit,
  balanceAfter:safe(BigInt(input.balance)-oldContribution+newContribution)};
}
