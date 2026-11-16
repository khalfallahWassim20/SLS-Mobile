/** Registre durable expérimental de révision v6. Toutes les fonctions sont à
 * appeler dans une transaction SQLite exclusive ; aucune route n'est activée. */
import {canonicalJson,calculateInvoice} from '@sls/domain';
import {assessDayInvoiceSaleRevision} from '../../packages/domain/src/day-invoice';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {assertDayInvoiceSyncIdle} from './day-invoice-sync-lock';
import {assertDayInvoiceAttemptsSettled} from './day-invoice-attempt-guard';
import {captureDayInvoiceSaleEdit,confirmDayInvoiceSaleEdit} from './day-invoice-sale-edit';
import {tunisDay} from './journal';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import type {SavedSale} from './storage';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export type SaleEditAttempt={saleId:number;clientId:string;day:string;lines:SavedSale['lines'];fingerprint:string;operationId:string;recordedAt:string};
type Result=Awaited<ReturnType<typeof confirmDayInvoiceSaleEdit>>;
export type StoredSaleEditAttempt={attempt:SaleEditAttempt;result:Result|null};
export const dayInvoiceSaleEditAttemptSchema=`CREATE TABLE IF NOT EXISTS day_invoice_sale_edit_attempt(id INTEGER PRIMARY KEY CHECK(id=1),commercial_id TEXT NOT NULL,server_origin TEXT NOT NULL,payload TEXT NOT NULL);`;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validAttempt(a:SaleEditAttempt){
 if(!a||typeof a!=='object'||Object.keys(a).sort().join(',')!=='clientId,day,fingerprint,lines,operationId,recordedAt,saleId'||!Number.isSafeInteger(a.saleId)||a.saleId<1||typeof a.clientId!=='string'||!uuid.test(a.clientId)||typeof a.operationId!=='string'||!uuid.test(a.operationId)||typeof a.fingerprint!=='string'||!a.fingerprint||typeof a.recordedAt!=='string'||!Number.isFinite(Date.parse(a.recordedAt))||new Date(a.recordedAt).toISOString()!==a.recordedAt||typeof a.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(a.day)||!Number.isFinite(Date.parse(`${a.day}T00:00:00.000Z`))||new Date(`${a.day}T00:00:00.000Z`).toISOString().slice(0,10)!==a.day||!Array.isArray(a.lines)||a.lines.length<1||a.lines.length>200)throw Error('Tentative de modification invalide.');
 for(const l of a.lines)if(!l||typeof l!=='object'||Object.keys(l).sort().join(',')!=='code,discount,name,quantity,unitPrice,vat'||typeof l.code!=='string'||!l.code||typeof l.name!=='string'||!l.name||!Number.isSafeInteger(l.quantity)||l.quantity<1||l.quantity>1000000||!Number.isSafeInteger(l.unitPrice)||l.unitPrice<0||!Number.isSafeInteger(l.discount)||l.discount<0||l.discount>10000||!Number.isSafeInteger(l.vat)||l.vat<0||l.vat>10000)throw Error('Article de modification invalide.');
}
async function bound(tx:Tx,identity:DeviceIdentity){const actual=await getDeviceIdentity(tx);if(!actual||actual.commercialId!==identity.commercialId||actual.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur incohérent.');}
export async function readSaleEditAttempt(tx:Tx,identity:DeviceIdentity):Promise<StoredSaleEditAttempt|null>{
 await bound(tx,identity);
 const row=await tx.getFirstAsync<{commercialId:string;serverOrigin:string;payload:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM day_invoice_sale_edit_attempt WHERE id=1');
 if(!row)return null;if(row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin)throw Error('Modification liée à un autre téléphone ou serveur.');
 let stored:StoredSaleEditAttempt;try{stored=JSON.parse(row.payload);if(!stored||Object.keys(stored).sort().join(',')!=='attempt,result')throw Error();validAttempt(stored.attempt);}catch{throw Error('Tentative de modification illisible.');}
 if(stored.result!==null){
  const a=stored.attempt,r=stored.result;
  const marker=await tx.getFirstAsync<{commercialId:string;kind:string;entityId:string;recordedAt:string}>('SELECT commercial_id AS commercialId,operation_kind AS kind,entity_id AS entityId,recorded_at AS recordedAt FROM identified_local_operations WHERE operation_id=?',a.operationId);
  const sale=await tx.getFirstAsync<{clientId:string;payload:string}>('SELECT client_id AS clientId,payload FROM sales WHERE id=?',a.saleId);
  const revisions=await tx.getAllAsync<{createdAt:string;previous:string;current:string;refund:number}>('SELECT created_at AS createdAt,previous_payload AS previous,new_payload AS current,refund FROM sale_revisions WHERE sale_id=? AND created_at=?',a.saleId,a.recordedAt);
  let current:unknown,previous:any,payload:unknown;try{current=JSON.parse(revisions[0]?.current??'');previous=JSON.parse(revisions[0]?.previous??'');payload=JSON.parse(sale?.payload??'');}catch{throw Error('Preuve de modification illisible.');}
  try{
   const captured=JSON.parse(a.fingerprint),invoice=JSON.parse(captured.invoice);
   const newTotal=calculateInvoice(a.lines.map(l=>({quantity:l.quantity,unitPrice:l.unitPrice,discountRate:l.discount,vatRate:l.vat}))).total;
   const assessed=assessDayInvoiceSaleRevision({...invoice.source,dayPayments:invoice.payments.map((p:any)=>({id:p.operationId,amount:p.amount,declaration:p.mode==='Crédit'}))},previous.syncSaleId,newTotal);
   const expected={...previous,lines:a.lines,total:newTotal,remaining:Math.max(0,newTotal-previous.paid),syncVersion:previous.syncVersion+1};
   const {id:_id,...updated}=expected;
   if(!r||r.operationId!==a.operationId||!r.updated||r.updated.id!==a.saleId||r.updated.clientId!==a.clientId||!r.updated.syncSaleId||tunisDay(new Date(r.updated.createdAt))!==a.day||assessed.requiresChoice||canonicalJson(captured.previous)!==canonicalJson(previous)||canonicalJson(captured.lines)!==canonicalJson(a.lines)||canonicalJson(r.assessment)!==canonicalJson(assessed)||!marker||marker.commercialId!==identity.commercialId||marker.kind!=='sale'||marker.entityId!==r.updated.syncSaleId||marker.recordedAt!==a.recordedAt||!sale||sale.clientId!==a.clientId||revisions.length!==1||revisions[0].refund!==0||previous?.id!==a.saleId||previous?.clientId!==a.clientId||canonicalJson(current)!==canonicalJson(expected)||canonicalJson(r.updated)!==canonicalJson(expected)||canonicalJson(payload)!==canonicalJson(updated))throw Error();
  }catch{throw Error('Preuve de modification incohérente : rapprochement nécessaire.');}
 }
 return stored;
}
export async function prepareSaleEditAttempt(tx:Tx,identity:DeviceIdentity,input:SaleEditAttempt,digest:(text:string)=>Promise<string>){
 validAttempt(input);const existing=await readSaleEditAttempt(tx,identity);
 if(existing){if(canonicalJson(existing.attempt)!==canonicalJson(input))throw Error('Une autre modification attend vérification.');return existing;}
 assertDayInvoiceSyncIdle();await assertDayInvoiceAttemptsSettled(tx,identity);const preview=await captureDayInvoiceSaleEdit(tx,identity,input.saleId,input.lines,digest);
 if(preview.previous.clientId!==input.clientId||preview.day!==input.day||preview.fingerprint!==input.fingerprint)throw Error('Facture ou solde modifié : vérifiez avant de confirmer.');
 if(preview.assessment.requiresChoice)throw Error('Total inférieur au montant payé : remboursement ou crédit requis.');
 const stored:StoredSaleEditAttempt={attempt:input,result:null};await tx.runAsync('INSERT INTO day_invoice_sale_edit_attempt(id,commercial_id,server_origin,payload) VALUES(1,?,?,?)',identity.commercialId,identity.serverOrigin,JSON.stringify(stored));return stored;
}
export async function confirmSaleEditAttempt(tx:Tx,identity:DeviceIdentity,operationId:string,digest:(text:string)=>Promise<string>){
 const stored=await readSaleEditAttempt(tx,identity);if(!stored||stored.attempt.operationId!==operationId)throw Error('Tentative de modification absente ou différente.');
 if(stored.result)return stored.result;
 assertDayInvoiceSyncIdle();await assertDayInvoiceAttemptsSettled(tx,identity,undefined,undefined,operationId);const a=stored.attempt;const result=await confirmDayInvoiceSaleEdit(tx,identity,a,digest);
 await tx.runAsync('UPDATE day_invoice_sale_edit_attempt SET payload=? WHERE id=1',JSON.stringify({...stored,result}));return result;
}
export async function acknowledgeSaleEditAttempt(tx:Tx,identity:DeviceIdentity,operationId:string){
 const stored=await readSaleEditAttempt(tx,identity);if(!stored||!stored.result||stored.attempt.operationId!==operationId)throw Error('Modification non confirmée ou reçu incohérent.');
 await tx.runAsync('DELETE FROM day_invoice_sale_edit_attempt WHERE id=1');
}
export async function cancelSaleEditAttempt(tx:Tx,identity:DeviceIdentity,operationId:string){
 const stored=await readSaleEditAttempt(tx,identity);if(!stored||stored.result||stored.attempt.operationId!==operationId)throw Error('Tentative non abandonnable.');
 const a=stored.attempt;const trace=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM identified_local_operations WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM sales_outbox WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM journal_sync_outbox WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_payments WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_old_debt_local WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM offline_credit_prototype WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM sale_revisions WHERE sale_id=? AND created_at=?) AS n`,a.operationId,a.operationId,a.operationId,a.operationId,a.operationId,a.operationId,a.saleId,a.recordedAt);
 if(!trace||trace.n)throw Error('Trace de modification existante : rapprochement nécessaire.');
 const ref=await readDayInvoiceReferenceCache(tx,identity);if(!ref||ref.dayPayments.some(p=>p.operationId.toLowerCase()===a.operationId.toLowerCase())||ref.settlementStates?.some(p=>p.operationId.toLowerCase()===a.operationId.toLowerCase()))throw Error('Référence ou trace serveur incohérente : rapprochement nécessaire.');
 await tx.runAsync('DELETE FROM day_invoice_sale_edit_attempt WHERE id=1');
}
