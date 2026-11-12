/** Comparaison consultative, fondée sur les identifiants et le contenu, pas
 * seulement les sommes. Ne prouve pas un versement ni les données hors ligne. */
import {z} from 'zod';
import {canonicalJson} from './canonical-json.ts';
const id=z.string().uuid(),amount=z.number().int().safe().nonnegative(),at=z.string().datetime(),mode=z.enum(['Espèces','Chèque','Virement']);
const cheque={mode,chequeNumber:z.string().max(100),chequeBank:z.string().max(100),chequeDue:z.string().max(100)};
const common={operationId:id,clientId:id,recordedAt:at};
const entry=z.discriminatedUnion('kind',[
 z.object({...common,kind:z.literal('invoice'),invoiceId:id,amount:amount.positive()}).strict(),
 z.object({...common,kind:z.literal('receipt'),invoiceId:id,receiptId:id,prePaid:amount,oldDebtPaid:amount,creditFull:z.boolean(),...cheque}).strict(),
 z.object({...common,kind:z.literal('settlement'),amount:amount.positive(),...cheque}).strict(),
 z.object({...common,kind:z.literal('credit'),invoiceId:id,invoiceKind:z.enum(['sale','preinvoice']),invoiceTotal:amount,refund:amount,retainedCredit:amount}).strict(),
 z.object({...common,kind:z.literal('admin-refund'),invoiceId:id,invoiceKind:z.enum(['sale','preinvoice']),assignmentId:id,refund:amount.positive()}).strict()
]);
const payload=z.object({version:z.literal(5),commercialId:id,day:z.string(),events:z.array(entry).max(20000)}).strict();
export type CashReconciliationEntry=z.infer<typeof entry>;
export function validateCashReconciliation(value:unknown,commercialId:string,day:string){
 const date=new Date(`${day}T00:00:00.000Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day)throw Error('Date de comparaison invalide.');
 const result=payload.safeParse(value);if(!result.success||result.data.commercialId!==commercialId||result.data.day!==day)throw Error('Comparaison des encaissements invalide ou identité différente.');
 const seen=new Set<string>();return result.data.events.map(e=>{
  if(seen.has(e.operationId))throw Error('Événement de caisse dupliqué.');seen.add(e.operationId);
  if('mode' in e&&e.mode==='Chèque'&&(e.kind==='settlement'||e.prePaid+e.oldDebtPaid>0)&&(!e.chequeNumber.trim()||!e.chequeBank.trim()||!e.chequeDue.trim()))throw Error('Chèque incomplet.');
  return {...e,recordedAt:new Date(e.recordedAt).toISOString()};
 });
}
export function compareCashReconciliation(local:unknown,server:unknown,commercialId:string,day:string){
 const left=validateCashReconciliation(local,commercialId,day),right=validateCashReconciliation(server,commercialId,day),serverById=new Map(right.map(e=>[e.operationId,e]));
 const differences:{status:'local'|'server'|'changed';kind:CashReconciliationEntry['kind'];operationId:string}[]=[];
 const add=(status:'local'|'server'|'changed',item:CashReconciliationEntry)=>{if(differences.length<8)differences.push({status,kind:item.kind,operationId:item.operationId});};
 let onlyLocal=0,changed=0;for(const item of left){const other=serverById.get(item.operationId);if(!other){onlyLocal++;add('local',item);continue;}serverById.delete(item.operationId);if(canonicalJson(item)!==canonicalJson(other)){changed++;add('changed',item);}}
 for(const item of serverById.values())add('server',item);
 return {matches:onlyLocal===0&&changed===0&&serverById.size===0,onlyLocal,onlyServer:serverById.size,changed,differences};
}

/** Représentation immuable et ordonnée des deux captures, liée à l'identité
 * et à la journée. À hacher avant l'envoi ; ce n'est pas une preuve physique. */
const saleCommon={operationId:id,saleId:id,clientId:id,recordedAt:at};
const saleCash=z.object({version:z.literal(5),commercialId:id,day:z.string(),
 initialEvents:z.array(z.object({...saleCommon,paid:amount}).strict()).max(200),
 refundEvents:z.array(z.object({...saleCommon,refund:amount.positive()}).strict()).max(40000),
 saleStates:z.array(z.object({saleId:id,clientId:id,version:z.number().int().positive().max(1000000),total:amount,paid:amount}).strict()).max(200)}).strict();
export function cashClosureCanonical(sales:unknown,journal:unknown,commercialId:string,day:string):string {
 const parsed=saleCash.safeParse(sales);if(!parsed.success||parsed.data.commercialId!==commercialId||parsed.data.day!==day)throw Error('Preuve de ventes invalide.');
 const salesSeen=new Set<string>(),tunis=(s:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(s));
 const order=<T extends {operationId:string}>(xs:T[])=>xs.sort((a,b)=>a.operationId<b.operationId?-1:a.operationId>b.operationId?1:0);
 const initial=order(parsed.data.initialEvents.map(e=>{if(salesSeen.has(e.operationId)||tunis(e.recordedAt)!==day)throw Error('Événement de vente invalide ou dupliqué.');salesSeen.add(e.operationId);return {...e,recordedAt:new Date(e.recordedAt).toISOString()};}));
 const refunds=order(parsed.data.refundEvents.map(e=>{if(salesSeen.has(e.operationId)||tunis(e.recordedAt)!==day)throw Error('Événement de vente invalide ou dupliqué.');salesSeen.add(e.operationId);return {...e,recordedAt:new Date(e.recordedAt).toISOString()};}));
 const saleIds=new Set(initial.map(e=>e.saleId)),statesSeen=new Set<string>();
 if(saleIds.size!==initial.length)throw Error('Vente initiale dupliquée.');
 const saleStates=parsed.data.saleStates.map(s=>{if(statesSeen.has(s.saleId)||!saleIds.has(s.saleId))throw Error('État de vente incohérent.');statesSeen.add(s.saleId);return s;}).sort((a,b)=>a.saleId<b.saleId?-1:a.saleId>b.saleId?1:0);
 if(saleStates.length!==saleIds.size)throw Error('État de vente incomplet.');
 const journalEvents=validateCashReconciliation(journal,commercialId,day);
 for(const e of journalEvents){
  if(tunis(e.recordedAt)!==day)throw Error('Événement de journal hors de la journée de clôture.');
  if(salesSeen.has(e.operationId))throw Error('Identifiant de mouvement dupliqué.');
 }
 return canonicalJson({protocol:'sls-cash-close-v1',commercialId,day,initial,refunds,saleStates,journalEvents:order(journalEvents)});
}
