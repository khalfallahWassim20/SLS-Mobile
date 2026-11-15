import {summarizePreInvoice,type PreInvoiceReceipt} from '@sls/domain';

/** Présentation locale, pas un solde client ni une preuve de synchronisation. */
export function journalVisualStatus(pre:{amount:number;receipts:PreInvoiceReceipt[]}|null,sales:readonly {total:number;paid:number}[]) {
 try {
  const summary=pre?summarizePreInvoice(pre.amount,pre.receipts):null;
  let saleRest=0n,paid=BigInt(summary?.prePaid??0);
  for(const sale of sales){
   if(!Number.isSafeInteger(sale.total)||sale.total<0||!Number.isSafeInteger(sale.paid)||sale.paid<0)throw Error('Vente invalide');
   saleRest+=BigInt(Math.max(0,sale.total-sale.paid));paid+=BigInt(sale.paid);
  }
  const remaining=saleRest+BigInt(summary?.remaining??0);
  if(remaining>BigInt(Number.MAX_SAFE_INTEGER)||paid>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Montant trop élevé');
  const rest=Number(remaining);
  if(summary&&!summary.declared)return {label:'Non traitée',tone:'coral' as const,rest};
  if(rest===0)return {label:'Soldée',tone:'mint' as const,rest};
  return {label:paid>0n?'Partiellement payée':'Impayée',tone:paid>0n?'amber' as const:'coral' as const,rest};
 } catch{return {label:'À vérifier',tone:'coral' as const,rest:null};}
}
