/** Projection préparatoire pour un client et une date de facture. L'appelant
 * doit déjà avoir rapproché toutes les sources et vérifié leur complétude.
 * Ne constitue ni un solde global ni une preuve de caisse consolidée. */
import {calculateDayInvoice,validateDayPayment,type DayInvoicePayment} from './day-invoice.ts';
import {canonicalJson} from './canonical-json.ts';
export type DayInvoiceViewSource={clientId:string;day:string;preInvoice:{id:string;version:number;total:number;paid:number;declared:boolean}|null;sales:readonly {id:string;version:number;total:number;paid:number}[]};
function civilDay(iso:string):string {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso));
 const get=(type:string)=>parts.find(x=>x.type===type)?.value;
 return `${get('year')}-${get('month')}-${get('day')}`;
}
const safe=(n:bigint)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw RangeError('Montant trop élevé');return Number(n);};
/** La copie locale et la copie serveur d'un même événement sont dédupliquées
 * uniquement si leur contenu entier est identique. Les règlements d'ancienne
 * dette ne sont jamais imputés ici. */
export function projectDayInvoiceView(source:DayInvoiceViewSource,local:readonly DayInvoicePayment[],remote:readonly DayInvoicePayment[]) {
 const saleMap=new Map(source.sales.map(s=>[s.id,s]));
 if(saleMap.size!==source.sales.length)throw RangeError('Vente dupliquée');
 const localMap=new Map<string,DayInvoicePayment>(),remoteMap=new Map<string,DayInvoicePayment>();
 const check=(event:DayInvoicePayment,target:Map<string,DayInvoicePayment>)=>{
  validateDayPayment(event);
  if(event.clientId!==source.clientId||event.day!==source.day||target.has(event.operationId))throw RangeError('Paiement du jour étranger ou dupliqué');
  // Une préétablie peut avoir été créée après un paiement d'une vente seule.
  // Un ancien paiement sans préétablie reste valide ; l'inverse n'est jamais vrai.
  if(event.preInvoice!==null&&source.preInvoice===null)throw RangeError('Facture du paiement indisponible');
  if(event.preInvoice&&source.preInvoice&&(event.preInvoice.id!==source.preInvoice.id||event.preInvoice.total!==source.preInvoice.total||event.preInvoice.version>source.preInvoice.version))throw RangeError('Preuve de facture invalide');
  for(const proof of event.sales){const sale=saleMap.get(proof.id);if(!sale||proof.version>sale.version)throw RangeError('Preuve de vente invalide');}
  target.set(event.operationId,event);
 };
 for(const p of local)check(p,localMap);for(const p of remote)check(p,remoteMap);
 const merged=new Map(remoteMap);
 for(const [id,p] of localMap){const other=merged.get(id);if(other&&canonicalJson(other)!==canonicalJson(p))throw RangeError('Paiement local et serveur divergent');merged.set(id,p);}
 const events=[...merged.values()].sort((a,b)=>a.recordedAt<b.recordedAt?-1:a.recordedAt>b.recordedAt?1:a.operationId<b.operationId?-1:a.operationId>b.operationId?1:0);
 if(events.filter(p=>p.preInvoice?.declare).length>1||events.some(p=>p.preInvoice?.declare&&!source.preInvoice?.declared))throw RangeError('Déclaration de facture incohérente');
 const result=calculateDayInvoice({preInvoice:source.preInvoice,sales:source.sales,dayPayments:events.map(p=>({id:p.operationId,amount:p.amount,declaration:p.mode==='Crédit'}))});
 const paid=safe(BigInt(result.alreadyPaid)+BigInt(result.dayPayments));
 const collectionByDay=new Map<string,{day:string;total:bigint;cash:bigint;cheque:bigint;transfer:bigint}>();
 for(const event of events){const day=civilDay(event.recordedAt);let item=collectionByDay.get(day);if(!item){item={day,total:0n,cash:0n,cheque:0n,transfer:0n};collectionByDay.set(day,item);}const n=BigInt(event.amount);item.total+=n;if(event.mode==='Espèces')item.cash+=n;else if(event.mode==='Chèque')item.cheque+=n;else item.transfer+=n;}
 return {clientId:source.clientId,day:source.day,preInvoiceTotal:source.preInvoice?.total??0,salesTotal:safe(source.sales.reduce((sum,s)=>sum+BigInt(s.total),0n)),total:result.total,paid,remaining:result.remaining,declared:source.preInvoice?.declared??true,
  payments:events.map(p=>({...p,pending:localMap.has(p.operationId)&&!remoteMap.has(p.operationId),collectionDay:civilDay(p.recordedAt)})),
  collectionByDay:[...collectionByDay.values()].sort((a,b)=>a.day.localeCompare(b.day)).map(p=>({day:p.day,total:safe(p.total),cash:safe(p.cash),cheque:safe(p.cheque),transfer:safe(p.transfer)}))};
}
