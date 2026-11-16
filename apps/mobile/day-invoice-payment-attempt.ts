import {assertDayInvoiceAttemptExclusive} from './day-invoice-attempt-guard';
/** Reprise durable expérimentale d'un règlement unifié. Toutes les fonctions
 * exigent une transaction SQLite exclusive ; le reçu et le paiement sont
 * écrits ensemble et ne sont pas effacés automatiquement. */
import {canonicalJson} from '@sls/domain';
import {validateDayPayment,validateDayInvoiceWrite,type DayInvoicePayment} from '../../packages/domain/src/day-invoice';
import {getDeviceIdentity,assertDeviceWritable,type DeviceIdentity} from './identified-device';
import {tunisDay} from './journal';
import {assertDayInvoiceSyncIdle} from './day-invoice-sync-lock';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {captureDayInvoiceForm,confirmDayInvoiceForm} from './day-invoice-form';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export type PaymentAttempt=Parameters<typeof confirmDayInvoiceForm>[2];
type Result=Awaited<ReturnType<typeof confirmDayInvoiceForm>>;
export type StoredPaymentAttempt={attempt:PaymentAttempt;result:Result|null};
export const dayInvoicePaymentAttemptSchema=`CREATE TABLE IF NOT EXISTS day_invoice_payment_attempt (
 id INTEGER PRIMARY KEY CHECK(id=1),commercial_id TEXT NOT NULL,server_origin TEXT NOT NULL,payload TEXT NOT NULL
);`;
const fields=['operationId','clientId','day','recordedAt','amount','mode','chequeNumber','chequeBank','chequeDue'] as const;
function validateAttempt(attempt:PaymentAttempt){
 if(!attempt||typeof attempt!=='object'||Array.isArray(attempt)||Object.keys(attempt).sort().join(',')!=='amount,chequeBank,chequeDue,chequeNumber,clientId,day,fingerprint,mode,operationId,recordedAt'||typeof attempt.fingerprint!=='string'||!attempt.fingerprint)throw Error('Tentative de règlement invalide.');
 // Une déclaration de crédit exige une preuve préétablie, contrôlée au moment
 // de la capture ; les autres champs sont vérifiés ici par le domaine.
 const payment={...attempt,preInvoice:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',version:1,total:1,declare:true},sales:[]};
 const {fingerprint:_fingerprint,...event}=payment;validateDayPayment(event);
}
async function bound(tx:Tx,identity:DeviceIdentity){const actual=await getDeviceIdentity(tx);if(!actual||actual.commercialId!==identity.commercialId||actual.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur incohérent.');}
export async function readDayPaymentAttempt(tx:Tx,identity:DeviceIdentity):Promise<StoredPaymentAttempt|null>{
 await bound(tx,identity);
 const row=await tx.getFirstAsync<{commercialId:string;serverOrigin:string;payload:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM day_invoice_payment_attempt WHERE id=1');
 if(!row)return null;if(row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin)throw Error('Tentative liée à un autre téléphone ou serveur.');
 let stored:StoredPaymentAttempt;try{stored=JSON.parse(row.payload);if(!stored||Object.keys(stored).sort().join(',')!=='attempt,result')throw Error();validateAttempt(stored.attempt);}catch{throw Error('Tentative de règlement illisible.');}
 if(stored.result!==null){
  const {attempt:a,result:r}=stored,payment=r?.payment;try{validateDayPayment(payment);}catch{throw Error('Reçu de règlement illisible.');}
  const original=await tx.getFirstAsync<{clientId:string;day:string;payload:string;commercialId:string;serverOrigin:string}>('SELECT client_id AS clientId,invoice_day AS day,payload,commercial_id AS commercialId,server_origin AS serverOrigin FROM day_invoice_payments WHERE operation_id=?',a.operationId);
  let local:DayInvoicePayment;try{local=JSON.parse(original?.payload??'');validateDayPayment(local);}catch{throw Error('Règlement local illisible.');}
  if(!original||original.commercialId!==identity.commercialId||original.serverOrigin!==identity.serverOrigin||original.clientId!==a.clientId||original.day!==a.day||fields.some(field=>payment[field]!==a[field])||canonicalJson(local)!==canonicalJson(payment)||!['created','duplicate'].includes(r.status))throw Error('Preuve de règlement incohérente : rapprochement nécessaire.');
 }
 return stored;
}
export async function prepareDayPaymentAttempt(tx:Tx,identity:DeviceIdentity,input:PaymentAttempt,digest:(text:string)=>Promise<string>){
 validateAttempt(input);const existing=await readDayPaymentAttempt(tx,identity);
 if(existing){if(canonicalJson(existing.attempt)!==canonicalJson(input))throw Error('Un autre règlement attend confirmation ou vérification.');return existing;}
 assertDayInvoiceSyncIdle();await assertDayInvoiceAttemptExclusive(tx,identity);await assertDeviceWritable(tx,identity,[input.day,tunisDay(new Date(input.recordedAt))]);
 const form=await captureDayInvoiceForm(tx,identity,input.clientId,input.day,digest);if(input.fingerprint!==form.fingerprint)throw Error('Facture modifiée : vérifiez avant de confirmer.');
 const pre=form.source.preInvoice;
 const payment:DayInvoicePayment={operationId:input.operationId,clientId:input.clientId,day:input.day,recordedAt:input.recordedAt,amount:input.amount,mode:input.mode,chequeNumber:input.chequeNumber,chequeBank:input.chequeBank,chequeDue:input.chequeDue,preInvoice:pre?{id:pre.id,version:pre.version,total:pre.total,declare:!pre.declared}:null,sales:form.source.sales.map(s=>({id:s.id,version:s.version}))};
 validateDayInvoiceWrite(payment,{...form.source,dayPayments:form.view.payments.map(p=>({id:p.operationId,amount:p.amount,declaration:p.mode==='Crédit'}))});
 const value:StoredPaymentAttempt={attempt:input,result:null};await tx.runAsync('INSERT INTO day_invoice_payment_attempt(id,commercial_id,server_origin,payload) VALUES(1,?,?,?)',identity.commercialId,identity.serverOrigin,JSON.stringify(value));return value;
}
export async function confirmDayPaymentAttempt(tx:Tx,identity:DeviceIdentity,operationId:string,digest:(text:string)=>Promise<string>){
 const stored=await readDayPaymentAttempt(tx,identity);if(!stored||stored.attempt.operationId!==operationId)throw Error('Tentative de règlement absente ou différente.');
 if(stored.result)return {...stored.result,status:'duplicate' as const};
 assertDayInvoiceSyncIdle();await assertDayInvoiceAttemptExclusive(tx,identity,{kind:'payment',operationId});
 const result=await confirmDayInvoiceForm(tx,identity,stored.attempt,digest);
 await tx.runAsync('UPDATE day_invoice_payment_attempt SET payload=? WHERE id=1',JSON.stringify({...stored,result}));return result;
}
export async function acknowledgeDayPaymentAttempt(tx:Tx,identity:DeviceIdentity,operationId:string){
 const stored=await readDayPaymentAttempt(tx,identity);if(!stored||!stored.result||stored.attempt.operationId!==operationId)throw Error('Règlement non confirmé ou reçu incohérent.');
 await tx.runAsync('DELETE FROM day_invoice_payment_attempt WHERE id=1');
}
/** Abandon uniquement si aucune trace locale ou serveur n'existe. */
export async function cancelDayPaymentAttempt(tx:Tx,identity:DeviceIdentity,operationId:string){
 const stored=await readDayPaymentAttempt(tx,identity);if(!stored||stored.result||stored.attempt.operationId!==operationId)throw Error('Tentative non abandonnable.');
 const present=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM identified_local_operations WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM sales_outbox WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM journal_sync_outbox WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_payments WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_payment_outbox WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_old_debt_local WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM offline_credit_prototype WHERE lower(operation_id)=lower(?)) AS n`,operationId,operationId,operationId,operationId,operationId,operationId,operationId);
 if(!present||present.n)throw Error('Trace de règlement existante : rapprochement nécessaire.');
 const ref=await readDayInvoiceReferenceCache(tx,identity);if(!ref||ref.dayPayments.some(p=>p.operationId.toLowerCase()===operationId.toLowerCase())||ref.settlementStates?.some(s=>s.operationId.toLowerCase()===operationId.toLowerCase()))throw Error('Référence ou trace serveur incohérente : rapprochement nécessaire.');
 await tx.runAsync('DELETE FROM day_invoice_payment_attempt WHERE id=1');
}
