/** Tentative de préétablie v6 : registre local et confirmation atomique.
 * Toute fonction exige une transaction SQLite exclusive. */
import {canonicalJson} from '@sls/domain';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {assertDayInvoiceSyncIdle} from './day-invoice-sync-lock';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {captureNewDayPreinvoice,confirmNewDayPreinvoice,type NewDayPreinvoice} from './day-invoice-preinvoice-create';
import {tunisDay} from './journal';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type Result=Awaited<ReturnType<typeof confirmNewDayPreinvoice>>;
export type StoredPreinvoiceAttempt={attempt:NewDayPreinvoice;result:Result|null};
export const dayInvoicePreinvoiceAttemptSchema=`CREATE TABLE IF NOT EXISTS day_invoice_preinvoice_attempt (
 id INTEGER PRIMARY KEY CHECK(id=1),commercial_id TEXT NOT NULL,server_origin TEXT NOT NULL,payload TEXT NOT NULL
);`;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validate(a:NewDayPreinvoice){
 if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).sort().join(',')!=='amount,clientId,createdAt,day,fingerprint,invoiceId,operationId'||typeof a.clientId!=='string'||!uuid.test(a.clientId)||typeof a.invoiceId!=='string'||!uuid.test(a.invoiceId)||typeof a.operationId!=='string'||!uuid.test(a.operationId)||a.invoiceId.toLowerCase()===a.operationId.toLowerCase()||!Number.isSafeInteger(a.amount)||a.amount<=0||typeof a.fingerprint!=='string'||!a.fingerprint||typeof a.createdAt!=='string'||!Number.isFinite(Date.parse(a.createdAt))||new Date(a.createdAt).toISOString()!==a.createdAt||tunisDay(new Date(a.createdAt))!==a.day)throw Error('Tentative de préétablie invalide.');
}
async function bound(tx:Tx,identity:DeviceIdentity){const b=await getDeviceIdentity(tx);if(!b||b.commercialId!==identity.commercialId||b.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur incohérent.');}
export async function readPreinvoiceAttempt(tx:Tx,identity:DeviceIdentity):Promise<StoredPreinvoiceAttempt|null>{
 await bound(tx,identity);const row=await tx.getFirstAsync<{commercialId:string;serverOrigin:string;payload:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM day_invoice_preinvoice_attempt WHERE id=1');
 if(!row)return null;if(row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin)throw Error('Tentative liée à un autre téléphone ou serveur.');
 let stored:StoredPreinvoiceAttempt;try{stored=JSON.parse(row.payload);if(!stored||Object.keys(stored).sort().join(',')!=='attempt,result')throw Error();validate(stored.attempt);}catch{throw Error('Tentative de préétablie illisible.');}
 if(stored.result!==null){
  const a=stored.attempt,r=stored.result,invoice=r?.invoice;
  const local=await tx.getFirstAsync<{clientId:string;day:string;payload:string}>('SELECT client_id AS clientId,journal_date AS day,payload FROM tour_pre_invoices WHERE id=?',a.invoiceId);
  const state=await tx.getFirstAsync<{version:number;payload:string}>('SELECT version,payload FROM journal_sync_state WHERE invoice_id=?',a.invoiceId);
  const marker=await tx.getFirstAsync<{commercialId:string;kind:string;entityId:string;recordedAt:string}>('SELECT commercial_id AS commercialId,operation_kind AS kind,entity_id AS entityId,recorded_at AS recordedAt FROM identified_local_operations WHERE operation_id=?',a.operationId);
  let snapshot:any,invoiceLocal:any;try{snapshot=JSON.parse(state?.payload??'');invoiceLocal=JSON.parse(local?.payload??'');}catch{throw Error('Préétablie locale illisible.');}
  const receipts=await tx.getFirstAsync<{n:number}>('SELECT count(*) AS n FROM tour_journal_receipts WHERE pre_invoice_id=?',a.invoiceId);
  if(!r||!['created','duplicate'].includes(r.status)||!invoice||invoice.id!==a.invoiceId||invoice.clientId!==a.clientId||invoice.journalDate!==a.day||invoice.amount!==a.amount||invoice.createdAt!==a.createdAt||!local||local.clientId!==a.clientId||local.day!==a.day||canonicalJson(invoiceLocal)!==canonicalJson(invoice)||!state||state.version!==1||snapshot.operationId!==a.operationId||snapshot.version!==1||canonicalJson(snapshot.invoice)!==canonicalJson(invoice)||canonicalJson(snapshot.receipts)!=='[]'||!receipts||receipts.n!==0||!marker||marker.commercialId!==identity.commercialId||marker.kind!=='journal'||marker.entityId!==a.invoiceId||marker.recordedAt!==a.createdAt)throw Error('Preuve de préétablie incohérente : rapprochement nécessaire.');
 }
 return stored;
}
export async function preparePreinvoiceAttempt(tx:Tx,identity:DeviceIdentity,input:NewDayPreinvoice,digest:(text:string)=>Promise<string>){
 validate(input);const existing=await readPreinvoiceAttempt(tx,identity);if(existing){if(canonicalJson(existing.attempt)!==canonicalJson(input))throw Error('Une autre préétablie attend confirmation ou vérification.');return existing;}
 assertDayInvoiceSyncIdle();const form=await captureNewDayPreinvoice(tx,identity,input.clientId,input.day,input.amount,digest);if(form.fingerprint!==input.fingerprint)throw Error('Facture ou solde modifié : vérifiez à nouveau.');
 const value:StoredPreinvoiceAttempt={attempt:input,result:null};await tx.runAsync('INSERT INTO day_invoice_preinvoice_attempt(id,commercial_id,server_origin,payload) VALUES(1,?,?,?)',identity.commercialId,identity.serverOrigin,JSON.stringify(value));return value;
}
export async function confirmPreinvoiceAttempt(tx:Tx,identity:DeviceIdentity,operationId:string,digest:(text:string)=>Promise<string>){
 const stored=await readPreinvoiceAttempt(tx,identity);if(!stored||stored.attempt.operationId!==operationId)throw Error('Tentative de préétablie absente ou différente.');
 if(stored.result)return {...stored.result,status:'duplicate' as const};const result=await confirmNewDayPreinvoice(tx,identity,stored.attempt,digest);
 await tx.runAsync('UPDATE day_invoice_preinvoice_attempt SET payload=? WHERE id=1',JSON.stringify({...stored,result}));return result;
}
export async function acknowledgePreinvoiceAttempt(tx:Tx,identity:DeviceIdentity,operationId:string){const stored=await readPreinvoiceAttempt(tx,identity);if(!stored||!stored.result||stored.attempt.operationId!==operationId)throw Error('Préétablie non confirmée ou reçu incohérent.');await tx.runAsync('DELETE FROM day_invoice_preinvoice_attempt WHERE id=1');}
export async function cancelPreinvoiceAttempt(tx:Tx,identity:DeviceIdentity,operationId:string){
 const stored=await readPreinvoiceAttempt(tx,identity);if(!stored||stored.result||stored.attempt.operationId!==operationId)throw Error('Tentative non abandonnable.');const a=stored.attempt;
 const present=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM identified_local_operations WHERE lower(operation_id)=lower(?) OR lower(entity_id)=lower(?)) OR EXISTS(SELECT 1 FROM sales_outbox WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM journal_sync_outbox WHERE lower(operation_id)=lower(?) OR lower(invoice_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_payments WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_old_debt_local WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM offline_credit_prototype WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM tour_pre_invoices WHERE lower(id)=lower(?)) OR EXISTS(SELECT 1 FROM journal_sync_state WHERE lower(invoice_id)=lower(?)) AS n`,a.operationId,a.invoiceId,a.operationId,a.operationId,a.invoiceId,a.operationId,a.operationId,a.operationId,a.invoiceId,a.invoiceId);
 if(!present||present.n)throw Error('Trace de préétablie existante : rapprochement nécessaire.');
 const ref=await readDayInvoiceReferenceCache(tx,identity);if(!ref||ref.journalStates?.some(j=>j.id.toLowerCase()===a.invoiceId.toLowerCase())||ref.dayPayments.some(p=>p.operationId.toLowerCase()===a.operationId.toLowerCase())||ref.settlementStates?.some(s=>s.operationId.toLowerCase()===a.operationId.toLowerCase()))throw Error('Référence ou trace serveur incohérente : rapprochement nécessaire.');
 await tx.runAsync('DELETE FROM day_invoice_preinvoice_attempt WHERE id=1');
}
