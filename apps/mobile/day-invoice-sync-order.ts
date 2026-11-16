/** Ordre préparatoire v6 : les preuves d'un paiement figent les versions
 * qu'il a vues. Une révision postérieure ne doit pas être envoyée avant lui. */
import type {IdentifiedEntry} from './identified-upload';
import type {DayInvoiceQueueEntry} from './day-invoice-queue';
import type {OldDebtEntry} from './day-invoice-old-debt-queue';
import type {DayInvoicePayment} from '../../packages/domain/src/day-invoice';
import {tunisDay} from './journal';

type Item={kind:'source';entry:IdentifiedEntry;time:number}|{kind:'payment';entry:DayInvoiceQueueEntry;time:number}|{kind:'debt';entry:OldDebtEntry;time:number};
function timestamp(value:unknown){if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw Error('Date de synchronisation invalide : rapprochement nécessaire.');return Date.parse(value);}
/** Les files ont été intégralement validées avant cet appel. L'ordre des
 * versions et les preuves des paiements priment sur les égalités d'horloge. */
export function orderDayInvoiceSync(sources:readonly IdentifiedEntry[],payments:readonly DayInvoiceQueueEntry[],debts:readonly OldDebtEntry[]):Item[]{
 const items:Item[]=[...sources.map(entry=>({kind:'source' as const,entry,time:timestamp(entry.recordedAt)})),...debts.map(entry=>({kind:'debt' as const,entry,time:timestamp(JSON.parse(entry.payload).event.settlement.createdAt)})),...payments.map(entry=>({kind:'payment' as const,entry,time:timestamp(JSON.parse(entry.payload).recordedAt)}))];
 if(items.length>2000)throw Error('Trop d’opérations en attente : synchronisation par rapprochement nécessaire.');
 const edges=items.map(()=>new Set<number>()),degree=items.map(()=>0);
 const edge=(a:number,b:number)=>{if(a!==b&&!edges[a].has(b)){edges[a].add(b);degree[b]++;}};
 const sourceData=sources.map(s=>JSON.parse(s.payload));
 // Une même entité doit arriver version par version, même avec horloge décalée.
 for(let i=0;i<sources.length;i++)for(let j=i+1;j<sources.length;j++)if(sources[i].kind===sources[j].kind&&sources[i].entityId===sources[j].entityId){
  const a=sourceData[i].version,b=sourceData[j].version;
  if(sources[i].kind==='settlement'||!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a===b)throw Error('Versions locales ambiguës.');
  edge(a<b?i:j,a<b?j:i);
 }
 const debtStart=sources.length,paymentStart=debtStart+debts.length;
 for(let i=1;i<debts.length;i++)edge(debtStart+i-1,debtStart+i);
 for(let i=1;i<payments.length;i++)edge(paymentStart+i-1,paymentStart+i);
 for(let p=0;p<payments.length;p++){
  const payment=JSON.parse(payments[p].payload) as DayInvoicePayment,index=paymentStart+p;
  for(let s=0;s<sources.length;s++){
   const entry=sources[s],data=sourceData[s];
   if(entry.kind==='sale'&&data.sale?.clientId===payment.clientId&&tunisDay(new Date(data.sale.createdAt))===payment.day){
    const known=payment.sales.find(v=>v.id===entry.entityId);
    if(known&&data.version<=known.version)edge(s,index);else edge(index,s);
   }else if(entry.kind==='journal'&&data.invoice?.clientId===payment.clientId&&data.invoice.journalDate===payment.day){
    const known=payment.preInvoice?.id===entry.entityId?payment.preInvoice:null;
    if(known&&data.version<=known.version)edge(s,index);else edge(index,s);
   }
  }
 }
 const pending=new Set(items.map((_,i)=>i)),ordered:Item[]=[];
 while(pending.size){
  const ready=[...pending].filter(i=>degree[i]===0).sort((a,b)=>items[a].time-items[b].time||a-b);
  if(!ready.length)throw Error('Ordre des opérations ambigu : rapprochement nécessaire.');
  const chosen=ready[0];pending.delete(chosen);ordered.push(items[chosen]);for(const next of edges[chosen])degree[next]--;
 }
 return ordered;
}
