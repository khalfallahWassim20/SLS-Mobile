import {canonicalJson} from '@sls/domain';
import {tunisDay} from './journal';
import type {DeviceIdentity} from './identified-device';
import {readOriginalExpenses,readExpenseRevisions,readExpenseCancellations,readTourExpenses} from './tour-expenses';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type Revision={operationId:string;version:number;recordedAt:string;previousDescription:string;previousAmount:number;description:string;amount:number};
type Cancellation={operationId:string;version:number;recordedAt:string;description:string;amount:number;reason:string};
type Item={operationId:string;createdAt:string;description:string;amount:number;revisions:Revision[];cancellation:Cancellation|null};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const text=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim()&&v.length<=200;
const money=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const instant=(v:unknown):v is string=>{if(typeof v!=='string')return false;const d=new Date(v);return Number.isFinite(d.getTime())&&d.toISOString()===v;};
const keys=(value:unknown,expected:string)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expected;
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);

/** Réception atomique et additive. Une file locale ou un historique divergent
 * bloque sans écraser : le serveur ne peut pas prouver l'état d'un téléphone hors ligne. */
export async function reconcileExpenseSnapshot(tx:Tx,id:DeviceIdentity,day:string,input:unknown):Promise<number> {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(`${day}T00:00:00Z`))||new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)!==day)throw Error('Date invalide.');
 if(!keys(input,'commercialId,day,expenses,version'))throw Error('Instantané de dépenses invalide.');
 const s=input as {version:unknown;commercialId:unknown;day:unknown;expenses:unknown};
 if(s.version!==1||s.commercialId!==id.commercialId||s.day!==day||!Array.isArray(s.expenses)||s.expenses.length>2000)throw Error('Instantané de dépenses invalide.');
 const ids=new Set<string>(),items:Item[]=[],expenseIds=new Set<string>();let revisionsCount=0;
 for(const raw of s.expenses){
  if(!keys(raw,'amount,cancellation,createdAt,description,operationId,revisions'))throw Error('Dépense distante invalide.');
  const e=raw as Item;if(!uuid(e.operationId)||ids.has(e.operationId)||!instant(e.createdAt)||tunisDay(new Date(e.createdAt))!==day||!text(e.description)||!money(e.amount)||!Array.isArray(e.revisions))throw Error('Dépense distante invalide.');
  ids.add(e.operationId);expenseIds.add(e.operationId);let last={version:1,recordedAt:e.createdAt,description:e.description,amount:e.amount};
  for(const r of e.revisions){
   revisionsCount++;if(revisionsCount>10000||!keys(r,'amount,description,operationId,previousAmount,previousDescription,recordedAt,version')||!uuid(r.operationId)||ids.has(r.operationId)||!Number.isSafeInteger(r.version)||r.version!==last.version+1||!instant(r.recordedAt)||r.recordedAt<last.recordedAt||r.previousDescription!==last.description||r.previousAmount!==last.amount||!text(r.description)||!money(r.amount)||(r.description===last.description&&r.amount===last.amount))throw Error('Historique distant invalide.');
   ids.add(r.operationId);last={version:r.version,recordedAt:r.recordedAt,description:r.description,amount:r.amount};
  }
  const c=e.cancellation;if(c!==null){if(!keys(c,'amount,description,operationId,reason,recordedAt,version')||!uuid(c.operationId)||ids.has(c.operationId)||c.version!==last.version||!instant(c.recordedAt)||c.recordedAt<last.recordedAt||c.description!==last.description||c.amount!==last.amount||!text(c.reason))throw Error('Annulation distante invalide.');ids.add(c.operationId);}
  items.push(e);
 }
 const originals=await readOriginalExpenses(tx,id),revisions=await readExpenseRevisions(tx,id,originals),cancellations=await readExpenseCancellations(tx,id,originals,revisions);
 if(originals.some(e=>e.pending)||revisions.some(r=>r.pending)||cancellations.some(c=>c.pending))throw Error('Synchronisez toutes les dépenses en attente avant l’actualisation.');
 if(originals.some(e=>e.day===day&&!expenseIds.has(e.operationId)))throw Error('Dépense locale absente du serveur : rapprochement nécessaire.');
 const allLocalIds=new Set([...originals.map(e=>e.operationId),...revisions.map(r=>r.operationId),...cancellations.map(c=>c.operationId)]);
 for(const e of items){
  const original=originals.find(x=>x.operationId===e.operationId),localRevisions=revisions.filter(r=>r.expenseId===e.operationId),localCancel=cancellations.find(c=>c.expenseId===e.operationId);
  if(original&&!same({operationId:original.operationId,createdAt:original.createdAt,description:original.description,amount:original.amount},{operationId:e.operationId,createdAt:e.createdAt,description:e.description,amount:e.amount}))throw Error('Dépense distante divergente : rapprochement nécessaire.');
  if(!original&&allLocalIds.has(e.operationId))throw Error('Identifiant distant déjà utilisé : rapprochement nécessaire.');
  if(localRevisions.length>e.revisions.length||localRevisions.some((r,i)=>!same({operationId:r.operationId,version:r.version,recordedAt:r.recordedAt,previousDescription:r.previousDescription,previousAmount:r.previousAmount,description:r.description,amount:r.amount},e.revisions[i])))throw Error('Versions de dépense divergentes : rapprochement nécessaire.');
  if(localCancel&&(!e.cancellation||!same({operationId:localCancel.operationId,version:localCancel.version,recordedAt:localCancel.recordedAt,description:localCancel.description,amount:localCancel.amount,reason:localCancel.reason},e.cancellation)))throw Error('Annulation distante divergente : rapprochement nécessaire.');
  for(const r of e.revisions.slice(localRevisions.length))if(allLocalIds.has(r.operationId))throw Error('Identifiant distant déjà utilisé : rapprochement nécessaire.');
  if(e.cancellation&&!localCancel&&allLocalIds.has(e.cancellation.operationId))throw Error('Identifiant distant déjà utilisé : rapprochement nécessaire.');
 }
 for(const e of items){
  const original=originals.find(x=>x.operationId===e.operationId),localRevisions=revisions.filter(r=>r.expenseId===e.operationId),localCancel=cancellations.find(c=>c.expenseId===e.operationId);
  if(!original)await tx.runAsync('INSERT INTO tour_expenses VALUES(?,?,?,?,?,?,?,0)',e.operationId,id.commercialId,id.serverOrigin,day,e.createdAt,e.description,e.amount);
  for(const r of e.revisions.slice(localRevisions.length))await tx.runAsync('INSERT INTO tour_expense_revisions VALUES(?,?,?,?,?,?,?,?,?,?,0)',r.operationId,e.operationId,id.commercialId,id.serverOrigin,r.version,r.recordedAt,r.previousDescription,r.previousAmount,r.description,r.amount);
  if(e.cancellation&&!localCancel){const c=e.cancellation;await tx.runAsync('INSERT INTO tour_expense_cancellations VALUES(?,?,?,?,?,?,?,?,?,0)',c.operationId,e.operationId,id.commercialId,id.serverOrigin,c.version,c.recordedAt,c.description,c.amount,c.reason);}
 }
 await readTourExpenses(tx,id);return items.length;
}
