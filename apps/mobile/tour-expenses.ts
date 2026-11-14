import {tunisDay} from './journal';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {assertLocalTourWritable} from './tour-close-queue';
import {assertLegacyMobileCreditSafe} from './credit-note-write-guard-prototype';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export type TourExpense={operationId:string;commercialId:string;serverOrigin:string;day:string;createdAt:string;description:string;amount:number;pending:number;version?:number;cancelled?:boolean};
export type ExpenseCancellation={operationId:string;expenseId:string;commercialId:string;serverOrigin:string;version:number;recordedAt:string;description:string;amount:number;reason:string;pending:number};
export type ExpenseRevision={operationId:string;expenseId:string;commercialId:string;serverOrigin:string;version:number;recordedAt:string;previousDescription:string;previousAmount:number;description:string;amount:number;pending:number};
export const tourExpenseSchema=`CREATE TABLE IF NOT EXISTS tour_expenses (
 operation_id TEXT PRIMARY KEY, commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL,
 journal_date TEXT NOT NULL, created_at TEXT NOT NULL, description TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>0), pending INTEGER NOT NULL CHECK(pending IN (0,1))
); CREATE INDEX IF NOT EXISTS tour_expenses_day ON tour_expenses(commercial_id,journal_date);
CREATE TABLE IF NOT EXISTS tour_expense_revisions (
 operation_id TEXT PRIMARY KEY, expense_id TEXT NOT NULL, commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>=2), recorded_at TEXT NOT NULL, previous_description TEXT NOT NULL,
 previous_amount INTEGER NOT NULL CHECK(previous_amount>0), description TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0),
 pending INTEGER NOT NULL CHECK(pending IN (0,1)), UNIQUE(expense_id,version)
); CREATE INDEX IF NOT EXISTS tour_expense_revisions_by_expense ON tour_expense_revisions(expense_id,version);
CREATE TABLE IF NOT EXISTS tour_expense_cancellations (
 operation_id TEXT PRIMARY KEY, expense_id TEXT NOT NULL UNIQUE, commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>=1), recorded_at TEXT NOT NULL, description TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>0), reason TEXT NOT NULL, pending INTEGER NOT NULL CHECK(pending IN (0,1))
);`;
const uuid=(s:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
async function bound(tx:Tx,id:DeviceIdentity){const current=await getDeviceIdentity(tx);if(!current||current.commercialId!==id.commercialId||current.serverOrigin!==id.serverOrigin)throw Error('Identité du téléphone incohérente.');}
export async function addTourExpense(tx:Tx,id:DeviceIdentity,expense:{operationId:string;createdAt:string;description:string;amount:number}) {
 await bound(tx,id);await assertLegacyMobileCreditSafe(tx,id);
 const date=new Date(expense.createdAt),description=expense.description.trim();
 if(!uuid(expense.operationId)||!Number.isFinite(date.getTime())||date.toISOString()!==expense.createdAt||!description||description.length>200||!Number.isSafeInteger(expense.amount)||expense.amount<=0)throw Error('Dépense invalide.');
 const day=tunisDay(date);await assertLocalTourWritable(tx,id.commercialId,day);
 const collision=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM tour_expense_revisions WHERE operation_id=?) OR EXISTS(SELECT 1 FROM tour_expense_cancellations WHERE operation_id=?) AS n',expense.operationId,expense.operationId);if(!collision||collision.n)throw Error('Identifiant de dépense déjà utilisé.');
 await tx.runAsync('INSERT INTO tour_expenses VALUES(?,?,?,?,?,?,?,1)',expense.operationId,id.commercialId,id.serverOrigin,day,expense.createdAt,description,expense.amount);
}
export async function readOriginalExpenses(tx:Tx,id:DeviceIdentity):Promise<TourExpense[]> {
 await bound(tx,id);await assertLegacyMobileCreditSafe(tx,id);
 const rows=await tx.getAllAsync<TourExpense>(`SELECT operation_id AS operationId,commercial_id AS commercialId,server_origin AS serverOrigin,journal_date AS day,created_at AS createdAt,description,amount,pending FROM tour_expenses ORDER BY created_at,operation_id`);
 for(const row of rows){const date=new Date(row.createdAt);if(row.commercialId!==id.commercialId||row.serverOrigin!==id.serverOrigin||!uuid(row.operationId)||!Number.isFinite(date.getTime())||date.toISOString()!==row.createdAt||tunisDay(date)!==row.day||typeof row.description!=='string'||!row.description.trim()||row.description.length>200||!Number.isSafeInteger(row.amount)||row.amount<=0||![0,1].includes(row.pending))throw Error('Dépense locale incohérente : rapprochement nécessaire.');}
 return rows;
}
export async function readExpenseRevisions(tx:Tx,id:DeviceIdentity,originals?:TourExpense[]):Promise<ExpenseRevision[]> {
 const source=originals??await readOriginalExpenses(tx,id);
 const rows=await tx.getAllAsync<ExpenseRevision>(`SELECT operation_id AS operationId,expense_id AS expenseId,commercial_id AS commercialId,server_origin AS serverOrigin,version,recorded_at AS recordedAt,previous_description AS previousDescription,previous_amount AS previousAmount,description,amount,pending FROM tour_expense_revisions ORDER BY expense_id,version`);
 const states=new Map(source.map(e=>[e.operationId,{...e,version:1,lastRecordedAt:e.createdAt}])),ids=new Set(source.map(e=>e.operationId));
 for(const r of rows){
  const current=states.get(r.expenseId),date=new Date(r.recordedAt);
  if(!current||!uuid(r.operationId)||ids.has(r.operationId)||r.commercialId!==id.commercialId||r.serverOrigin!==id.serverOrigin||r.version!==current.version+1||!Number.isFinite(date.getTime())||date.toISOString()!==r.recordedAt||Date.parse(r.recordedAt)<Date.parse(current.lastRecordedAt)||r.previousDescription!==current.description||r.previousAmount!==current.amount||typeof r.description!=='string'||!r.description.trim()||r.description.length>200||!Number.isSafeInteger(r.amount)||r.amount<=0||![0,1].includes(r.pending)||(current.pending===1&&r.pending===0))throw Error('Historique des dépenses incohérent : rapprochement nécessaire.');
  ids.add(r.operationId);states.set(r.expenseId,{...current,version:r.version,lastRecordedAt:r.recordedAt,description:r.description,amount:r.amount,pending:current.pending||r.pending?1:0});
 }
 return rows;
}
export async function readExpenseCancellations(tx:Tx,id:DeviceIdentity,originals?:TourExpense[],revisions?:ExpenseRevision[]):Promise<ExpenseCancellation[]> {
 const source=originals??await readOriginalExpenses(tx,id),history=revisions??await readExpenseRevisions(tx,id,source);
 const rows=await tx.getAllAsync<ExpenseCancellation>(`SELECT operation_id AS operationId,expense_id AS expenseId,commercial_id AS commercialId,server_origin AS serverOrigin,version,recorded_at AS recordedAt,description,amount,reason,pending FROM tour_expense_cancellations ORDER BY recorded_at,operation_id`);
 const ids=new Set([...source.map(e=>e.operationId),...history.map(r=>r.operationId)]),seen=new Set<string>();
 const originalsById=new Map(source.map(e=>[e.operationId,e])),revisionsByExpense=new Map<string,ExpenseRevision[]>();
 for(const r of history){const group=revisionsByExpense.get(r.expenseId);if(group)group.push(r);else revisionsByExpense.set(r.expenseId,[r]);}
 for(const c of rows){
  const original=originalsById.get(c.expenseId),all=revisionsByExpense.get(c.expenseId)??[],last=all.at(-1),date=new Date(c.recordedAt);
  if(!original||seen.has(c.expenseId)||!uuid(c.operationId)||ids.has(c.operationId)||c.commercialId!==id.commercialId||c.serverOrigin!==id.serverOrigin||c.version!==(last?.version??1)||c.description!==(last?.description??original.description)||c.amount!==(last?.amount??original.amount)||!Number.isFinite(date.getTime())||date.toISOString()!==c.recordedAt||Date.parse(c.recordedAt)<Date.parse(last?.recordedAt??original.createdAt)||typeof c.reason!=='string'||!c.reason.trim()||c.reason!==c.reason.trim()||c.reason.length>200||![0,1].includes(c.pending)||(c.pending===0&&(original.pending===1||all.some(r=>r.pending))))throw Error('Annulation de dépense incohérente : rapprochement nécessaire.');
  ids.add(c.operationId);seen.add(c.expenseId);
 }
 return rows;
}
export async function readTourExpenses(tx:Tx,id:DeviceIdentity):Promise<TourExpense[]> {
 const originals=await readOriginalExpenses(tx,id),revisions=await readExpenseRevisions(tx,id,originals),cancellations=await readExpenseCancellations(tx,id,originals,revisions);
 const latestByExpense=new Map<string,ExpenseRevision>(),pendingByExpense=new Set<string>(),cancelByExpense=new Map(cancellations.map(c=>[c.expenseId,c]));
 for(const r of revisions){latestByExpense.set(r.expenseId,r);if(r.pending)pendingByExpense.add(r.expenseId);}
 return originals.map(e=>{const latest=latestByExpense.get(e.operationId),cancel=cancelByExpense.get(e.operationId);return {...e,version:latest?.version??1,description:latest?.description??e.description,amount:latest?.amount??e.amount,pending:e.pending||pendingByExpense.has(e.operationId)||cancel?.pending?1:0,...(cancel?{cancelled:true}:{})};});
}
/** Chaque correction ajoute une version, sans modifier ou effacer l'original. */
export async function reviseTourExpense(tx:Tx,id:DeviceIdentity,expected:TourExpense,change:{operationId:string;recordedAt:string;description:string;amount:number}) {
 const rows=await readTourExpenses(tx,id),current=rows.find(e=>e.operationId===expected.operationId),date=new Date(change.recordedAt),description=change.description.trim();
 if(!current||JSON.stringify(current)!==JSON.stringify(expected))throw Error('Dépense modifiée : rouvrez-la avant correction.');
 if(current.cancelled)throw Error('Dépense annulée : correction impossible.');
 if(!uuid(change.operationId)||!Number.isFinite(date.getTime())||date.toISOString()!==change.recordedAt||Date.parse(change.recordedAt)<Date.parse(current.createdAt)||!description||description.length>200||!Number.isSafeInteger(change.amount)||change.amount<=0||!current.version||current.version>=1000000)throw Error('Correction de dépense invalide.');
 if(current.amount===change.amount&&current.description===description)throw Error('Aucune modification à enregistrer.');
 const revisions=await readExpenseRevisions(tx,id),latest=revisions.filter(r=>r.expenseId===current.operationId).at(-1);
 if(rows.some(e=>e.operationId===change.operationId)||revisions.some(r=>r.operationId===change.operationId)||(await readExpenseCancellations(tx,id)).some(c=>c.operationId===change.operationId))throw Error('Identifiant de correction déjà utilisé.');
 if(latest&&Date.parse(change.recordedAt)<Date.parse(latest.recordedAt))throw Error('Horloge incohérente : correction refusée.');
 await assertLocalTourWritable(tx,id.commercialId,current.day);const recordedDay=tunisDay(date);if(recordedDay!==current.day)await assertLocalTourWritable(tx,id.commercialId,recordedDay);
 await tx.runAsync('INSERT INTO tour_expense_revisions VALUES(?,?,?,?,?,?,?,?,?,?,1)',change.operationId,current.operationId,id.commercialId,id.serverOrigin,current.version+1,change.recordedAt,current.description,current.amount,description,change.amount);
}
export async function cancelTourExpense(tx:Tx,id:DeviceIdentity,expected:TourExpense,change:{operationId:string;recordedAt:string;reason:string}) {
 const rows=await readTourExpenses(tx,id),current=rows.find(e=>e.operationId===expected.operationId),date=new Date(change.recordedAt),reason=change.reason.trim();
 if(!current||JSON.stringify(current)!==JSON.stringify(expected))throw Error('Dépense modifiée : rouvrez-la avant annulation.');
 if(current.cancelled)throw Error('Dépense déjà annulée.');
 const revisions=await readExpenseRevisions(tx,id),cancellations=await readExpenseCancellations(tx,id),latest=revisions.filter(r=>r.expenseId===current.operationId).at(-1);
 if(!uuid(change.operationId)||rows.some(e=>e.operationId===change.operationId)||revisions.some(r=>r.operationId===change.operationId)||cancellations.some(c=>c.operationId===change.operationId)||!Number.isFinite(date.getTime())||date.toISOString()!==change.recordedAt||Date.parse(change.recordedAt)<Date.parse(latest?.recordedAt??current.createdAt)||!reason||reason.length>200||!current.version)throw Error('Annulation de dépense invalide.');
 await assertLocalTourWritable(tx,id.commercialId,current.day);const recordedDay=tunisDay(date);if(recordedDay!==current.day)await assertLocalTourWritable(tx,id.commercialId,recordedDay);
 await tx.runAsync('INSERT INTO tour_expense_cancellations VALUES(?,?,?,?,?,?,?,?,?,1)',change.operationId,current.operationId,id.commercialId,id.serverOrigin,current.version,change.recordedAt,current.description,current.amount,reason);
}
export async function acknowledgeExpenseCancellation(tx:Tx,id:DeviceIdentity,cancellation:ExpenseCancellation,response:unknown) {
 const value=response as {status?:unknown;operationId?:unknown}|null;
 if(!value||!['received','duplicate'].includes(String(value.status))||value.operationId!==cancellation.operationId)throw Error('Accusé d’annulation invalide.');
 const current=(await readExpenseCancellations(tx,id)).find(c=>c.operationId===cancellation.operationId);
 if(!current||current.pending!==1||JSON.stringify(current)!==JSON.stringify(cancellation))throw Error('Annulation modifiée : accusé refusé.');
 const original=(await readOriginalExpenses(tx,id)).find(e=>e.operationId===current.expenseId),revisions=await readExpenseRevisions(tx,id);
 if(!original||original.pending||revisions.some(r=>r.expenseId===current.expenseId&&r.pending))throw Error('Accusé d’annulation hors ordre : synchronisez d’abord les versions précédentes.');
 await tx.runAsync('UPDATE tour_expense_cancellations SET pending=0 WHERE operation_id=?',cancellation.operationId);
}
export async function acknowledgeExpenseRevision(tx:Tx,id:DeviceIdentity,revision:ExpenseRevision,response:unknown) {
 const value=response as {status?:unknown;operationId?:unknown}|null;
 if(!value||!['received','duplicate'].includes(String(value.status))||value.operationId!==revision.operationId)throw Error('Accusé de correction invalide.');
 const rows=await readExpenseRevisions(tx,id),current=rows.find(r=>r.operationId===revision.operationId);
 if(!current||current.pending!==1||JSON.stringify(current)!==JSON.stringify(revision))throw Error('Correction modifiée : accusé refusé.');
 const original=(await readOriginalExpenses(tx,id)).find(e=>e.operationId===current.expenseId);
 if(!original||original.pending||rows.some(r=>r.expenseId===current.expenseId&&r.version<current.version&&r.pending))throw Error('Accusé de correction hors ordre : synchronisez d’abord les versions précédentes.');
 await tx.runAsync('UPDATE tour_expense_revisions SET pending=0 WHERE operation_id=?',revision.operationId);
}
export async function acknowledgeTourExpense(tx:Tx,id:DeviceIdentity,expense:TourExpense,response:unknown) {
 await bound(tx,id);await assertLegacyMobileCreditSafe(tx,id);
 const value=response as {status?:unknown;operationId?:unknown}|null;
 if(!value||!['received','duplicate'].includes(String(value.status))||value.operationId!==expense.operationId)throw Error('Accusé de dépense invalide.');
 const rows=await readOriginalExpenses(tx,id),current=rows.find(x=>x.operationId===expense.operationId);
 const {version:_version,...expected}=expense;
 if(!current||current.pending!==1||JSON.stringify(current)!==JSON.stringify(expected))throw Error('Dépense modifiée : accusé refusé.');
 await tx.runAsync('UPDATE tour_expenses SET pending=0 WHERE operation_id=?',expense.operationId);
}
