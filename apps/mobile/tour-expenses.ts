import {tunisDay} from './journal';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {assertLocalTourWritable} from './tour-close-queue';
import {assertLegacyMobileCreditSafe} from './credit-note-write-guard-prototype';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export type TourExpense={operationId:string;commercialId:string;serverOrigin:string;day:string;createdAt:string;description:string;amount:number;pending:number};
export const tourExpenseSchema=`CREATE TABLE IF NOT EXISTS tour_expenses (
 operation_id TEXT PRIMARY KEY, commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL,
 journal_date TEXT NOT NULL, created_at TEXT NOT NULL, description TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>0), pending INTEGER NOT NULL CHECK(pending IN (0,1))
); CREATE INDEX IF NOT EXISTS tour_expenses_day ON tour_expenses(commercial_id,journal_date);`;
const uuid=(s:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
async function bound(tx:Tx,id:DeviceIdentity){const current=await getDeviceIdentity(tx);if(!current||current.commercialId!==id.commercialId||current.serverOrigin!==id.serverOrigin)throw Error('Identité du téléphone incohérente.');}
export async function addTourExpense(tx:Tx,id:DeviceIdentity,expense:{operationId:string;createdAt:string;description:string;amount:number}) {
 await bound(tx,id);await assertLegacyMobileCreditSafe(tx,id);
 const date=new Date(expense.createdAt),description=expense.description.trim();
 if(!uuid(expense.operationId)||!Number.isFinite(date.getTime())||date.toISOString()!==expense.createdAt||!description||description.length>200||!Number.isSafeInteger(expense.amount)||expense.amount<=0)throw Error('Dépense invalide.');
 const day=tunisDay(date);await assertLocalTourWritable(tx,id.commercialId,day);
 await tx.runAsync('INSERT INTO tour_expenses VALUES(?,?,?,?,?,?,?,1)',expense.operationId,id.commercialId,id.serverOrigin,day,expense.createdAt,description,expense.amount);
}
export async function readTourExpenses(tx:Tx,id:DeviceIdentity):Promise<TourExpense[]> {
 await bound(tx,id);await assertLegacyMobileCreditSafe(tx,id);
 const rows=await tx.getAllAsync<TourExpense>(`SELECT operation_id AS operationId,commercial_id AS commercialId,server_origin AS serverOrigin,journal_date AS day,created_at AS createdAt,description,amount,pending FROM tour_expenses ORDER BY created_at,operation_id`);
 for(const row of rows){const date=new Date(row.createdAt);if(row.commercialId!==id.commercialId||row.serverOrigin!==id.serverOrigin||!uuid(row.operationId)||!Number.isFinite(date.getTime())||date.toISOString()!==row.createdAt||tunisDay(date)!==row.day||typeof row.description!=='string'||!row.description.trim()||row.description.length>200||!Number.isSafeInteger(row.amount)||row.amount<=0||![0,1].includes(row.pending))throw Error('Dépense locale incohérente : rapprochement nécessaire.');}
 return rows;
}
export async function acknowledgeTourExpense(tx:Tx,id:DeviceIdentity,expense:TourExpense,response:unknown) {
 await bound(tx,id);await assertLegacyMobileCreditSafe(tx,id);
 const value=response as {status?:unknown;operationId?:unknown}|null;
 if(!value||!['received','duplicate'].includes(String(value.status))||value.operationId!==expense.operationId)throw Error('Accusé de dépense invalide.');
 const rows=await readTourExpenses(tx,id),current=rows.find(x=>x.operationId===expense.operationId);
 if(!current||current.pending!==1||JSON.stringify(current)!==JSON.stringify(expense))throw Error('Dépense modifiée : accusé refusé.');
 await tx.runAsync('UPDATE tour_expenses SET pending=0 WHERE operation_id=?',expense.operationId);
}
