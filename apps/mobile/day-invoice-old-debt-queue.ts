/** File v6 expérimentale : règlement explicitement distinct de la facture du
 * jour. Toutes les fonctions sont appelées dans une transaction exclusive. */
import {canonicalJson} from '@sls/domain';
import {getDeviceIdentity,recordDeviceOperation,type DeviceIdentity} from './identified-device';
import {tunisDay} from './journal';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export const dayInvoiceOldDebtSchema=`CREATE TABLE IF NOT EXISTS day_invoice_old_debt_local (
 operation_id TEXT PRIMARY KEY,client_id TEXT NOT NULL,invoice_day TEXT NOT NULL,payload TEXT NOT NULL,commercial_id TEXT NOT NULL,server_origin TEXT NOT NULL
); CREATE TABLE IF NOT EXISTS day_invoice_old_debt_outbox (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,commercial_id TEXT NOT NULL,server_origin TEXT NOT NULL,
 FOREIGN KEY(operation_id) REFERENCES day_invoice_old_debt_local(operation_id)
);`;
export type OldDebtSettlement={syncOperationId:string;createdAt:string;clientId:string;clientName:string;amount:number;mode:'Espèces'|'Chèque'|'Virement';chequeNumber:string;chequeBank:string;chequeDue:string};
export type OldDebtEvent={invoiceDay:string;event:{operationId:string;settlement:OldDebtSettlement}};
export type OldDebtEntry={sequence:number;operationId:string;payload:string;commercialId:string;serverOrigin:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function validateOldDebtEvent(raw:unknown):asserts raw is OldDebtEvent {
 if(!object(raw)||Object.keys(raw).sort().join(',')!=='event,invoiceDay'||!object(raw.event)||Object.keys(raw.event).sort().join(',')!=='operationId,settlement'||!object(raw.event.settlement))throw Error('Règlement ancienne dette invalide.');
 const s=raw.event.settlement,keys=['syncOperationId','createdAt','clientId','clientName','amount','mode','chequeNumber','chequeBank','chequeDue'];
 if(Object.keys(s).length!==keys.length||keys.some(k=>!(k in s))||typeof s.syncOperationId!=='string'||!uuid.test(s.syncOperationId)||raw.event.operationId!==s.syncOperationId||typeof s.clientId!=='string'||!uuid.test(s.clientId)||typeof s.clientName!=='string'||!s.clientName.trim()||s.clientName!==s.clientName.trim()||s.clientName.length>200||!Number.isSafeInteger(s.amount)||s.amount<=0||!['Espèces','Chèque','Virement'].includes(s.mode))throw Error('Règlement ancienne dette invalide.');
 if(typeof s.createdAt!=='string'||!Number.isFinite(Date.parse(s.createdAt))||new Date(s.createdAt).toISOString()!==s.createdAt||typeof raw.invoiceDay!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(raw.invoiceDay)||tunisDay(new Date(s.createdAt))!==raw.invoiceDay)throw Error('Date de règlement invalide.');
 for(const field of ['chequeNumber','chequeBank','chequeDue'])if(typeof s[field]!=='string'||s[field].length>100)throw Error('Chèque invalide.');
 if(s.mode==='Chèque'?[s.chequeNumber,s.chequeBank,s.chequeDue].some((x:string)=>!x.trim()):!!(s.chequeNumber||s.chequeBank||s.chequeDue))throw Error('Chèque invalide.');
}
async function assertBound(tx:Tx,identity:DeviceIdentity){const actual=await getDeviceIdentity(tx);if(!actual||actual.commercialId!==identity.commercialId||actual.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur du téléphone incohérent.');}
/** L'appelant fournit une garde complète sous le même verrou SQLite. */
export async function appendOldDebt(tx:Tx,identity:DeviceIdentity,event:OldDebtEvent,guard:(tx:Tx,event:OldDebtEvent)=>Promise<void>):Promise<'created'|'duplicate'> {
 validateOldDebtEvent(event);await assertBound(tx,identity);const payload=JSON.stringify(event),id=event.event.operationId,s=event.event.settlement;
 const existing=await tx.getFirstAsync<{payload:string;commercialId:string;serverOrigin:string}>('SELECT payload,commercial_id AS commercialId,server_origin AS serverOrigin FROM day_invoice_old_debt_local WHERE operation_id=?',id);
 if(existing){
  if(existing.payload!==payload||existing.commercialId!==identity.commercialId||existing.serverOrigin!==identity.serverOrigin)throw Error('Identifiant de règlement déjà utilisé.');
  const settlements=await tx.getAllAsync<{payload:string}>('SELECT payload FROM settlements WHERE client_id=?',s.clientId);
  const same=settlements.filter(row=>{try{return JSON.parse(row.payload).syncOperationId===id;}catch{return false;}});
  const origin=await tx.getFirstAsync<{commercialId:string;kind:string;entityId:string;recordedAt:string}>('SELECT commercial_id AS commercialId,operation_kind AS kind,entity_id AS entityId,recorded_at AS recordedAt FROM identified_local_operations WHERE operation_id=?',id);
  if(same.length!==1||canonicalJson(JSON.parse(same[0].payload))!==canonicalJson(s)||!origin||origin.commercialId!==identity.commercialId||origin.kind!=='settlement'||origin.entityId!==id||origin.recordedAt!==s.createdAt)throw Error('Historique de règlement incohérent.');
  return 'duplicate';
 }
 await guard(tx,event);
 const collision=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM identified_local_operations WHERE operation_id=?) OR EXISTS(SELECT 1 FROM sales_outbox WHERE operation_id=?) OR EXISTS(SELECT 1 FROM journal_sync_outbox WHERE operation_id=?) OR EXISTS(SELECT 1 FROM day_invoice_payments WHERE operation_id=?) OR EXISTS(SELECT 1 FROM offline_credit_prototype WHERE operation_id=?) AS n`,id,id,id,id,id);
 if(!collision||collision.n)throw Error('Identifiant de règlement déjà utilisé.');
 await tx.runAsync('INSERT INTO settlements(created_at,client_id,payload) VALUES(?,?,?)',s.createdAt,s.clientId,JSON.stringify(s));
 await recordDeviceOperation(tx,identity,id,'settlement',id,s.createdAt);
 await tx.runAsync('INSERT INTO day_invoice_old_debt_local(operation_id,client_id,invoice_day,payload,commercial_id,server_origin) VALUES(?,?,?,?,?,?)',id,s.clientId,event.invoiceDay,payload,identity.commercialId,identity.serverOrigin);
 await tx.runAsync('INSERT INTO day_invoice_old_debt_outbox(operation_id,payload,commercial_id,server_origin) VALUES(?,?,?,?)',id,payload,identity.commercialId,identity.serverOrigin);
 return 'created';
}
/** Refuse les lignes orphelines, altérées ou attribuées à un autre appareil. */
export async function readOldDebtOutbox(tx:Tx,identity:DeviceIdentity):Promise<OldDebtEntry[]>{
 await assertBound(tx,identity);
 const rows=await tx.getAllAsync<OldDebtEntry&{originalPayload:string|null;originalClientId:string|null;originalDay:string|null;originalCommercialId:string|null;originalServerOrigin:string|null}>(`SELECT o.sequence,o.operation_id AS operationId,o.payload,o.commercial_id AS commercialId,o.server_origin AS serverOrigin,l.payload AS originalPayload,l.client_id AS originalClientId,l.invoice_day AS originalDay,l.commercial_id AS originalCommercialId,l.server_origin AS originalServerOrigin FROM day_invoice_old_debt_outbox o LEFT JOIN day_invoice_old_debt_local l ON l.operation_id=o.operation_id ORDER BY o.sequence LIMIT 20001`);
 if(rows.length>20000)throw Error('File ancienne dette trop longue.');
 for(const r of rows){let event:unknown;try{event=JSON.parse(r.payload);validateOldDebtEvent(event);}catch{throw Error('File ancienne dette illisible.');}
  const e=event as OldDebtEvent;
  if(r.commercialId!==identity.commercialId||r.serverOrigin!==identity.serverOrigin||r.originalPayload!==r.payload||r.originalCommercialId!==r.commercialId||r.originalServerOrigin!==r.serverOrigin||e.event.operationId!==r.operationId||e.event.settlement.clientId!==r.originalClientId||e.invoiceDay!==r.originalDay)throw Error('File ancienne dette incohérente.');
  const matches=await tx.getAllAsync<{payload:string}>('SELECT payload FROM settlements WHERE client_id=?',e.event.settlement.clientId);
  if(matches.filter(m=>{try{return JSON.parse(m.payload).syncOperationId===r.operationId;}catch{return false;}}).length!==1||!matches.some(m=>{try{return canonicalJson(JSON.parse(m.payload))===canonicalJson(e.event.settlement);}catch{return false;}}))throw Error('Historique de règlement incohérent.');
  const origin=await tx.getFirstAsync<{commercialId:string;kind:string;entityId:string;recordedAt:string}>('SELECT commercial_id AS commercialId,operation_kind AS kind,entity_id AS entityId,recorded_at AS recordedAt FROM identified_local_operations WHERE operation_id=?',r.operationId);
  if(!origin||origin.commercialId!==identity.commercialId||origin.kind!=='settlement'||origin.entityId!==r.operationId||origin.recordedAt!==e.event.settlement.createdAt)throw Error('Origine de règlement incohérente.');
 }
 return rows.map(({sequence,operationId,payload,commercialId,serverOrigin})=>({sequence,operationId,payload,commercialId,serverOrigin}));
}
export async function acknowledgeOldDebt(tx:Tx,identity:DeviceIdentity,entry:OldDebtEntry):Promise<void>{
 const rows=await readOldDebtOutbox(tx,identity),actual=rows.find(r=>r.operationId===entry.operationId);
 if(!actual||canonicalJson(actual)!==canonicalJson(entry))throw Error('File ancienne dette modifiée : accusé refusé.');
 await tx.runAsync('DELETE FROM day_invoice_old_debt_outbox WHERE operation_id=?',entry.operationId);
}
