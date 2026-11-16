import {assertDayInvoiceAttemptExclusive} from './day-invoice-attempt-guard';
/** Reprise durable expérimentale du règlement d'ancienne dette, distinct du
 * paiement de la facture. Transaction SQLite exclusive obligatoire. */
import {canonicalJson} from '@sls/domain';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {assertDayInvoiceSyncIdle} from './day-invoice-sync-lock';
import {captureOldDebtForm,confirmOldDebtForm} from './day-invoice-old-debt-form';
import {validateOldDebtEvent,type OldDebtEvent} from './day-invoice-old-debt-queue';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export type OldDebtAttempt={fingerprint:string;event:OldDebtEvent};
export type StoredOldDebtAttempt={attempt:OldDebtAttempt;result:'created'|'duplicate'|null};
export const dayInvoiceOldDebtAttemptSchema=`CREATE TABLE IF NOT EXISTS day_invoice_old_debt_attempt (
 id INTEGER PRIMARY KEY CHECK(id=1),commercial_id TEXT NOT NULL,server_origin TEXT NOT NULL,payload TEXT NOT NULL
);`;
function validate(input:OldDebtAttempt){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='event,fingerprint'||typeof input.fingerprint!=='string'||!input.fingerprint)throw Error('Tentative de règlement invalide.');validateOldDebtEvent(input.event);}
async function bound(tx:Tx,identity:DeviceIdentity){const b=await getDeviceIdentity(tx);if(!b||b.commercialId!==identity.commercialId||b.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur incohérent.');}
export async function readOldDebtAttempt(tx:Tx,identity:DeviceIdentity):Promise<StoredOldDebtAttempt|null>{
 await bound(tx,identity);const row=await tx.getFirstAsync<{commercialId:string;serverOrigin:string;payload:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM day_invoice_old_debt_attempt WHERE id=1');
 if(!row)return null;if(row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin)throw Error('Tentative liée à un autre téléphone ou serveur.');
 let stored:StoredOldDebtAttempt;try{stored=JSON.parse(row.payload);if(!stored||Object.keys(stored).sort().join(',')!=='attempt,result')throw Error();validate(stored.attempt);if(stored.result!==null&&!['created','duplicate'].includes(stored.result))throw Error();}catch{throw Error('Tentative de dette illisible.');}
 if(stored.result!==null){const e=stored.attempt.event,s=e.event.settlement,id=e.event.operationId;
  const original=await tx.getFirstAsync<{clientId:string;day:string;payload:string;commercialId:string;serverOrigin:string}>('SELECT client_id AS clientId,invoice_day AS day,payload,commercial_id AS commercialId,server_origin AS serverOrigin FROM day_invoice_old_debt_local WHERE operation_id=?',id);
  const origin=await tx.getFirstAsync<{commercialId:string;kind:string;entityId:string;recordedAt:string}>('SELECT commercial_id AS commercialId,operation_kind AS kind,entity_id AS entityId,recorded_at AS recordedAt FROM identified_local_operations WHERE operation_id=?',id);
  const rows=await tx.getAllAsync<{payload:string}>('SELECT payload FROM settlements WHERE client_id=?',s.clientId);
  let local:OldDebtEvent;try{local=JSON.parse(original?.payload??'');validateOldDebtEvent(local);}catch{throw Error('Règlement local illisible.');}
  const matches=rows.filter(r=>{try{return JSON.parse(r.payload).syncOperationId===id;}catch{throw Error('Règlement local illisible.');}});
  if(!original||original.clientId!==s.clientId||original.day!==e.invoiceDay||original.commercialId!==identity.commercialId||original.serverOrigin!==identity.serverOrigin||canonicalJson(local)!==canonicalJson(e)||!origin||origin.commercialId!==identity.commercialId||origin.kind!=='settlement'||origin.entityId!==id||origin.recordedAt!==s.createdAt||matches.length!==1||canonicalJson(JSON.parse(matches[0].payload))!==canonicalJson(s))throw Error('Preuve de règlement incohérente : rapprochement nécessaire.');
 }
 return stored;
}
export async function prepareOldDebtAttempt(tx:Tx,identity:DeviceIdentity,input:OldDebtAttempt,digest:(text:string)=>Promise<string>){
 validate(input);const existing=await readOldDebtAttempt(tx,identity);if(existing){if(canonicalJson(existing.attempt)!==canonicalJson(input))throw Error('Un autre règlement attend confirmation ou vérification.');return existing;}
 assertDayInvoiceSyncIdle();await assertDayInvoiceAttemptExclusive(tx,identity);const s=input.event.event.settlement,form=await captureOldDebtForm(tx,identity,s.clientId,input.event.invoiceDay,digest);
 if(form.fingerprint!==input.fingerprint||form.clientName!==s.clientName)throw Error('Solde ou facture modifié : vérifiez avant de confirmer.');if(s.amount>form.available)throw Error('Règlement supérieur à l’ancienne dette disponible.');
 const value:StoredOldDebtAttempt={attempt:input,result:null};await tx.runAsync('INSERT INTO day_invoice_old_debt_attempt(id,commercial_id,server_origin,payload) VALUES(1,?,?,?)',identity.commercialId,identity.serverOrigin,JSON.stringify(value));return value;
}
export async function confirmOldDebtAttempt(tx:Tx,identity:DeviceIdentity,operationId:string,digest:(text:string)=>Promise<string>){
 const stored=await readOldDebtAttempt(tx,identity);if(!stored||stored.attempt.event.event.operationId!==operationId)throw Error('Tentative de règlement absente ou différente.');
 if(stored.result)return 'duplicate' as const;assertDayInvoiceSyncIdle();await assertDayInvoiceAttemptExclusive(tx,identity,{kind:'oldDebt',operationId});const result=await confirmOldDebtForm(tx,identity,stored.attempt,digest);
 await tx.runAsync('UPDATE day_invoice_old_debt_attempt SET payload=? WHERE id=1',JSON.stringify({...stored,result}));return result;
}
export async function acknowledgeOldDebtAttempt(tx:Tx,identity:DeviceIdentity,operationId:string){const stored=await readOldDebtAttempt(tx,identity);if(!stored||!stored.result||stored.attempt.event.event.operationId!==operationId)throw Error('Règlement non confirmé ou reçu incohérent.');await tx.runAsync('DELETE FROM day_invoice_old_debt_attempt WHERE id=1');}
export async function cancelOldDebtAttempt(tx:Tx,identity:DeviceIdentity,operationId:string){
 const stored=await readOldDebtAttempt(tx,identity);if(!stored||stored.result||stored.attempt.event.event.operationId!==operationId)throw Error('Tentative non abandonnable.');
 const present=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM identified_local_operations WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM sales_outbox WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM journal_sync_outbox WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_payments WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_payment_outbox WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_old_debt_local WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_old_debt_outbox WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM offline_credit_prototype WHERE lower(operation_id)=lower(?)) AS n`,operationId,operationId,operationId,operationId,operationId,operationId,operationId,operationId);
 if(!present||present.n)throw Error('Trace de règlement existante : rapprochement nécessaire.');
 const rows=await tx.getAllAsync<{payload:string}>('SELECT payload FROM settlements');for(const row of rows){let s:any;try{s=JSON.parse(row.payload);}catch{throw Error('Règlement local illisible.');}if(typeof s?.syncOperationId==='string'&&s.syncOperationId.toLowerCase()===operationId.toLowerCase())throw Error('Trace de règlement existante : rapprochement nécessaire.');}
 const ref=await readDayInvoiceReferenceCache(tx,identity);if(!ref||ref.dayPayments.some(p=>p.operationId.toLowerCase()===operationId.toLowerCase())||ref.settlementStates?.some(s=>s.operationId.toLowerCase()===operationId.toLowerCase()))throw Error('Référence ou trace serveur incohérente : rapprochement nécessaire.');
 await tx.runAsync('DELETE FROM day_invoice_old_debt_attempt WHERE id=1');
}
