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
