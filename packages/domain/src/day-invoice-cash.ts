/** Preuve expérimentale v6 : ne modifie pas le format ni les gardes de la
 * clôture v5. Une correspondance ne prouve jamais le versement physique. */
import {canonicalJson} from './canonical-json.ts';
import {cashClosureCanonical} from './cash-reconciliation.ts';
import {validateDayPayment,type DayInvoicePayment} from './day-invoice.ts';
const tunisDay=(at:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
function payments(input:unknown,day:string):DayInvoicePayment[] {
 const date=new Date(`${day}T00:00:00.000Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day)throw Error('Date de comparaison invalide.');
 if(!Array.isArray(input)||input.length>20000)throw Error('Preuve des règlements unifiés invalide.');
 const seen=new Set<string>();
 return input.map(p=>{validateDayPayment(p);if(tunisDay(p.recordedAt)!==day||seen.has(p.operationId))throw Error('Règlement unifié hors journée ou dupliqué.');seen.add(p.operationId);return p as DayInvoicePayment;}).sort((a,b)=>a.operationId<b.operationId?-1:a.operationId>b.operationId?1:0);
}
export function compareDayInvoiceCash(local:unknown,server:unknown,day:string){
 const left=payments(local,day),right=payments(server,day),remote=new Map(right.map(p=>[p.operationId,p]));
 let onlyLocal=0,changed=0;const differences:{status:'local'|'server'|'changed';operationId:string}[]=[];
 const add=(status:'local'|'server'|'changed',operationId:string)=>{if(differences.length<8)differences.push({status,operationId});};
 for(const p of left){const other=remote.get(p.operationId);if(!other){onlyLocal++;add('local',p.operationId);}else{remote.delete(p.operationId);if(canonicalJson(p)!==canonicalJson(other)){changed++;add('changed',p.operationId);}}}
 for(const p of remote.values())add('server',p.operationId);
 return {matches:onlyLocal===0&&changed===0&&remote.size===0,onlyLocal,onlyServer:remote.size,changed,differences};
}
export function dayInvoiceCashClosureCanonical(sales:unknown,journal:unknown,dayPayments:unknown,commercialId:string,day:string,ownerDeclarations:unknown):string {
 const legacy=JSON.parse(cashClosureCanonical(sales,journal,commercialId,day));
 const used=new Set<string>([...legacy.initial,...legacy.refunds,...legacy.journalEvents].map((e:{operationId:string})=>e.operationId));
 const entries=payments(dayPayments,day);
 for(const p of entries){if(used.has(p.operationId))throw Error('Identifiant de mouvement dupliqué.');used.add(p.operationId);}
 if(!Array.isArray(ownerDeclarations)||ownerDeclarations.length>1000)throw Error('Preuve des déclarations de factures invalide.');
 const invoiceEvents=new Map<string,any>(legacy.journalEvents.filter((e:any)=>e.kind==='invoice').map((e:any)=>[e.invoiceId,e]));
 const declarationIds=new Set<string>(),invoiceIds=new Set<string>(),cashById=new Map(entries.map(e=>[e.operationId,e]));
 const declarations:DayInvoicePayment[]=ownerDeclarations.map(p=>{
  validateDayPayment(p);const pre=p.preInvoice,invoice=pre?invoiceEvents.get(pre.id):undefined;
  if(p.day!==day||!pre?.declare||!invoice||invoice.clientId!==p.clientId||invoice.amount!==pre.total||declarationIds.has(p.operationId)||invoiceIds.has(pre.id))throw Error('Déclaration de facture incohérente ou dupliquée.');
  if(legacy.journalEvents.some((e:any)=>e.kind==='receipt'&&e.invoiceId===pre.id&&(e.creditFull||e.prePaid>0)))throw Error('Déclaration de facture déjà enregistrée.');
  const cash=cashById.get(p.operationId);
  if(cash&&canonicalJson(cash)!==canonicalJson(p))throw Error('Déclaration de facture divergente.');
  if(!cash&&used.has(p.operationId))throw Error('Identifiant de mouvement dupliqué.');
  declarationIds.add(p.operationId);invoiceIds.add(pre.id);return p as DayInvoicePayment;
 }).sort((a,b)=>a.operationId<b.operationId?-1:a.operationId>b.operationId?1:0);
 return canonicalJson({protocol:'sls-cash-close-v3',commercialId,day,legacy,dayPayments:entries,ownerDeclarations:declarations});
}
