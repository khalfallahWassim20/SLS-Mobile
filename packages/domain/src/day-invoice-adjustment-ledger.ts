/** Projection expérimentale d'un historique de compensations de facture du jour.
 * Calcul pur : aucun remboursement, crédit, écriture ou synchronisation n'est
 * effectué. Ne pas utiliser comme preuve de versement physique. */
import {calculateDayInvoice,type DayInvoiceInput} from './day-invoice.ts';
export type AdjustmentOpening={invoice:DayInvoiceInput;saleVersions:readonly {id:string;version:number}[];balance:number};
export type AdjustmentEvent=
 |{kind:'payment';operationId:string;amount:number}
 |{kind:'revision';operationId:string;saleId:string;expectedVersion:number;newTotal:number;choice:'refund'|'credit'|null;compensation:number};
function natural(n:unknown):bigint{if(!Number.isSafeInteger(n)||Number(n)<0)throw new RangeError('Montant invalide');return BigInt(n as number);}
function checked(n:bigint):number{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw new RangeError('Montant trop élevé');return Number(n);}
function id(value:unknown):string{if(typeof value!=='string'||!value.trim()||value!==value.trim())throw new RangeError('Identifiant invalide');return value.toLowerCase();}
/** Les événements sont déjà classés dans l'ordre de validation transactionnel.
 * Un crédit attribué reste un crédit global : le modèle ne le réutilise pas
 * automatiquement comme règlement d'une facture ultérieure. */
export function replayDayInvoiceAdjustments(opening:AdjustmentOpening,events:readonly AdjustmentEvent[]){
 if(!opening||!Number.isSafeInteger(opening.balance)||!Array.isArray(opening.saleVersions)||!Array.isArray(events)||events.length>20000)throw new RangeError('Historique invalide');
 const initial=calculateDayInvoice(opening.invoice);if(initial.remaining<0)throw new RangeError('Facture initiale surpayée');
 const versions=new Map<string,number>();for(const v of opening.saleVersions){const key=id(v.id);if(versions.has(key)||!Number.isSafeInteger(v.version)||v.version<1||v.version>1000000)throw new RangeError('Version de vente invalide');versions.set(key,v.version);}
 const sales=new Map<string,bigint>();for(const sale of opening.invoice.sales){const key=id(sale.id);if(sales.has(key)||!versions.has(key))throw new RangeError('Vente ou version incohérente');sales.set(key,natural(sale.total));}
 if(versions.size!==sales.size)throw new RangeError('Version de vente sans source');
 const seen=new Set<string>();for(const p of opening.invoice.dayPayments){const key=id(p.id);if(seen.has(key))throw new RangeError('Paiement dupliqué');seen.add(key);}
 let total=BigInt(initial.total),applied=BigInt(initial.alreadyPaid)+BigInt(initial.dayPayments),balance=BigInt(opening.balance),refunds=0n,credits=0n;
 for(const event of events){
  if(!event||typeof event!=='object'||Array.isArray(event))throw new RangeError('Mouvement invalide');
  const op=id(event.operationId);if(seen.has(op))throw new RangeError('Opération dupliquée');seen.add(op);
  if(event.kind==='payment'){
   if(Object.keys(event).sort().join(',')!=='amount,kind,operationId')throw new RangeError('Paiement invalide');
   const amount=natural(event.amount);if(amount===0n||amount>total-applied)throw new RangeError('Paiement supérieur au reste ou nul');
   applied+=amount;balance-=amount;
  }else if(event.kind==='revision'){
   if(Object.keys(event).sort().join(',')!=='choice,compensation,expectedVersion,kind,newTotal,operationId,saleId')throw new RangeError('Révision invalide');
   const key=id(event.saleId),before=sales.get(key),version=versions.get(key),next=natural(event.newTotal),compensation=natural(event.compensation);
   if(before===undefined||version===undefined||event.expectedVersion!==version||version>=1000000)throw new RangeError('Vente ou version modifiée');
   const delta=next-before,after=total+delta;if(after<0n)throw new RangeError('Total modifié invalide');
   const excess=applied>after?applied-after:0n;
   if(compensation!==excess||(excess===0n?event.choice!==null:event.choice!=='refund'&&event.choice!=='credit'))throw new RangeError('Compensation ou choix incohérent');
   applied-=excess;balance+=delta;
   if(event.choice==='refund'){refunds+=excess;balance+=excess;}else if(event.choice==='credit')credits+=excess;
   total=after;sales.set(key,next);versions.set(key,version+1);
  }else throw new RangeError('Type de mouvement invalide');
  checked(total);checked(applied);checked(balance);checked(refunds);checked(credits);
 }
 return {total:checked(total),applied:checked(applied),remaining:checked(total-applied),balance:checked(balance),refunds:checked(refunds),credits:checked(credits),sales:[...sales].map(([key,value])=>({id:opening.invoice.sales.find(s=>s.id.toLowerCase()===key)!.id,total:checked(value),version:versions.get(key)!}))};
}
