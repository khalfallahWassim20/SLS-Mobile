/** Avant tout calcul ou écriture v6, un paiement local doit être conservé
 * dans la file vérifiée ou figurer à l'identique dans la référence serveur.
 * Une ligne SQLite seule ne prouve pas que le paiement pourra être synchronisé. */
import {canonicalJson} from '@sls/domain';
import type {DayInvoicePayment} from '../../packages/domain/src/day-invoice';
import type {DayInvoiceQueueEntry} from './day-invoice-queue';
import type {validateDayInvoiceReference} from './day-invoice-reference';
export function assertLocalDayPaymentProofs(payments:readonly DayInvoicePayment[],queue:readonly DayInvoiceQueueEntry[],reference:ReturnType<typeof validateDayInvoiceReference>):void{
 const queued=new Map(queue.map(q=>[q.operationId,q])),remote=new Map(reference.dayPayments.map(p=>[p.operationId,p]));
 for(const payment of payments){
  const entry=queued.get(payment.operationId),server=remote.get(payment.operationId),payload=canonicalJson(payment);
  if(!entry&&!server)throw Error('Preuve de paiement indisponible : rapprochement nécessaire.');
  if(entry){let value:unknown;try{value=JSON.parse(entry.payload);}catch{throw Error('File de paiement illisible.');}if(canonicalJson(value)!==payload)throw Error('File de paiement incohérente : rapprochement nécessaire.');}
  if(server&&canonicalJson(server)!==payload)throw Error('Paiement local et serveur incohérents : rapprochement nécessaire.');
 }
}
