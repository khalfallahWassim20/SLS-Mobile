/** Preuve préparatoire des dépenses d'une journée. Elle ne prouve pas la
 * présence des opérations encore hors ligne ni la réalité des paiements. */
import {canonicalJson} from './canonical-json.ts';

const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const text=(x:unknown):x is string=>typeof x==='string'&&x.length<=200&&!!x.trim()&&x===x.trim();
const amount=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>0;
const instant=(x:unknown):x is string=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const keys=(x:unknown,k:string)=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===k;
const tunisDay=(x:string)=>{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(x));const get=(key:string)=>parts.find(p=>p.type===key)?.value;return `${get('year')}-${get('month')}-${get('day')}`;};
export type ExpenseProofRevision={operationId:string;version:number;recordedAt:string;previousDescription:string;previousAmount:number;description:string;amount:number};
export type ExpenseProofCancellation={operationId:string;version:number;recordedAt:string;description:string;amount:number;reason:string};
export type ExpenseProofItem={operationId:string;createdAt:string;description:string;amount:number;revisions:ExpenseProofRevision[];cancellation:ExpenseProofCancellation|null};
export type ExpenseProofSnapshot={version:1;commercialId:string;day:string;expenses:ExpenseProofItem[]};

/** Vérifie et rejoue toutes les versions ; tri stable sans mutation des données. */
export function expenseClosureCanonical(input:unknown,commercialId:string,day:string):string {
 const date=new Date(`${day}T00:00:00.000Z`);
 if(!uuid(commercialId)||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day||!keys(input,'commercialId,day,expenses,version'))throw Error('Identité ou preuve de dépenses invalide.');
 const s=input as ExpenseProofSnapshot;
 if(s.version!==1||s.commercialId!==commercialId||s.day!==day||!Array.isArray(s.expenses)||s.expenses.length>2000)throw Error('Preuve de dépenses invalide.');
 const ids=new Set<string>();let revisionCount=0,total=0n;
 const add=(id:unknown)=>{if(!uuid(id)||ids.has(id.toLowerCase()))throw Error('Identifiant de dépense invalide ou dupliqué.');ids.add(id.toLowerCase());};
 for(const e of s.expenses){
  if(!keys(e,'amount,cancellation,createdAt,description,operationId,revisions')||!instant(e.createdAt)||tunisDay(e.createdAt)!==day||!text(e.description)||!amount(e.amount)||!Array.isArray(e.revisions))throw Error('Dépense invalide.');
  add(e.operationId);let previous={version:1,recordedAt:e.createdAt,description:e.description,amount:e.amount};
  for(const r of e.revisions){
   if(++revisionCount>10000||!keys(r,'amount,description,operationId,previousAmount,previousDescription,recordedAt,version')||!Number.isSafeInteger(r.version)||r.version!==previous.version+1||r.version>1000000||!instant(r.recordedAt)||r.recordedAt<previous.recordedAt||r.previousDescription!==previous.description||r.previousAmount!==previous.amount||!text(r.description)||!amount(r.amount)||(r.description===previous.description&&r.amount===previous.amount))throw Error('Correction de dépense invalide.');
   add(r.operationId);previous={version:r.version,recordedAt:r.recordedAt,description:r.description,amount:r.amount};
  }
  const c=e.cancellation;
  if(c!==null){if(!keys(c,'amount,description,operationId,reason,recordedAt,version')||c.version!==previous.version||!instant(c.recordedAt)||c.recordedAt<previous.recordedAt||c.description!==previous.description||c.amount!==previous.amount||!text(c.reason))throw Error('Annulation de dépense invalide.');add(c.operationId);}
  else total+=BigInt(previous.amount);
 }
 if(total>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Total des dépenses trop élevé.');
 const expenses=[...s.expenses].sort((a,b)=>a.operationId<b.operationId?-1:a.operationId>b.operationId?1:0);
 return canonicalJson({protocol:'sls-expense-close-v1',commercialId,day,expenses,total:Number(total)});
}
