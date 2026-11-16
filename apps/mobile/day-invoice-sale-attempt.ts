import {assertDayInvoiceAttemptExclusive} from './day-invoice-attempt-guard';
/** Reprise locale expérimentale d'une vente v6. Toutes les fonctions doivent
 * être appelées dans une transaction SQLite exclusive liée au téléphone.
 * Une seule tentative est ouverte à la fois ; aucune donnée n'est supprimée
 * automatiquement après une confirmation ou une erreur. */
import {canonicalJson,calculateInvoice} from '@sls/domain';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {assertDayInvoiceSyncIdle} from './day-invoice-sync-lock';
import {tunisDay} from './journal';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {captureNewDayInvoiceSale,confirmNewDayInvoiceSale} from './day-invoice-sale-create';
import type {NewSaleAttempt} from './day-invoice-sale-create-input';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type Result=Awaited<ReturnType<typeof confirmNewDayInvoiceSale>>;
type Stored={attempt:NewSaleAttempt;result:Result|null};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const dayInvoiceSaleAttemptSchema=`CREATE TABLE IF NOT EXISTS day_invoice_sale_attempt (
 id INTEGER PRIMARY KEY CHECK(id=1),commercial_id TEXT NOT NULL,server_origin TEXT NOT NULL,payload TEXT NOT NULL
);`;
function validAttempt(input:NewSaleAttempt){
 if(!input||typeof input!=='object'||Object.keys(input).sort().join(',')!=='clientId,createdAt,day,fingerprint,lines,operationId,saleId'||!uuid.test(input.clientId)||!uuid.test(input.saleId)||!uuid.test(input.operationId)||input.saleId.toLowerCase()===input.operationId.toLowerCase()||typeof input.fingerprint!=='string'||!input.fingerprint||typeof input.createdAt!=='string'||!Number.isFinite(Date.parse(input.createdAt))||new Date(input.createdAt).toISOString()!==input.createdAt||tunisDay(new Date(input.createdAt))!==input.day||!Array.isArray(input.lines)||input.lines.length<1||input.lines.length>200)throw Error('Tentative de vente invalide.');
 for(const l of input.lines)if(!l||typeof l!=='object'||Object.keys(l).sort().join(',')!=='code,discount,name,quantity,unitPrice,vat'||typeof l.code!=='string'||typeof l.name!=='string'||!Number.isSafeInteger(l.quantity)||l.quantity<1||l.quantity>1000000||!Number.isSafeInteger(l.unitPrice)||l.unitPrice<0||!Number.isSafeInteger(l.discount)||l.discount<0||l.discount>10000||!Number.isSafeInteger(l.vat)||l.vat<0||l.vat>10000)throw Error('Article de tentative invalide.');
}
async function bound(tx:Tx,identity:DeviceIdentity){const actual=await getDeviceIdentity(tx);if(!actual||actual.commercialId!==identity.commercialId||actual.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur incohérent.');}
/** Lecture vérifiée, y compris après redémarrage et après retrait de la file. */
export async function readDaySaleAttempt(tx:Tx,identity:DeviceIdentity):Promise<Stored|null>{
 await bound(tx,identity);
 const row=await tx.getFirstAsync<{commercialId:string;serverOrigin:string;payload:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM day_invoice_sale_attempt WHERE id=1');
 if(!row)return null;if(row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin)throw Error('Tentative liée à un autre téléphone ou serveur.');
 let stored:Stored;try{stored=JSON.parse(row.payload);if(!stored||Object.keys(stored).sort().join(',')!=='attempt,result')throw Error();validAttempt(stored.attempt);}catch{throw Error('Tentative de vente illisible.');}
 if(stored.result!==null){
  const {attempt:a,result:r}=stored;
  const marker=await tx.getFirstAsync<{commercialId:string;kind:string;entityId:string;recordedAt:string}>('SELECT commercial_id AS commercialId,operation_kind AS kind,entity_id AS entityId,recorded_at AS recordedAt FROM identified_local_operations WHERE operation_id=?',a.operationId);
  const rows=await tx.getAllAsync<{clientId:string;createdAt:string;payload:string}>('SELECT client_id AS clientId,created_at AS createdAt,payload FROM sales WHERE client_id=?',a.clientId);
  const matches=rows.filter(item=>{try{return JSON.parse(item.payload).syncSaleId===a.saleId;}catch{throw Error('Vente locale illisible.');}});
  const sale=r?.sale;
  let total:number;try{total=calculateInvoice(a.lines.map(l=>({quantity:l.quantity,unitPrice:l.unitPrice,discountRate:l.discount,vatRate:l.vat}))).total;}catch{throw Error('Tentative de vente illisible.');}
  if(!marker||marker.commercialId!==identity.commercialId||marker.kind!=='sale'||marker.entityId!==a.saleId||marker.recordedAt!==a.createdAt||matches.length!==1||matches[0].createdAt!==a.createdAt||matches[0].clientId!==a.clientId||!sale||sale.syncSaleId!==a.saleId||sale.syncVersion!==1||sale.clientId!==a.clientId||sale.createdAt!==a.createdAt||sale.total!==total||sale.paid!==0||sale.remaining!==total||sale.paymentMode!=='Crédit'||sale.chequeNumber!==''||sale.chequeBank!==''||sale.chequeDue!==''||canonicalJson(sale.lines)!==canonicalJson(a.lines)||canonicalJson(JSON.parse(matches[0].payload))!==canonicalJson(sale)||r.operationId!==a.operationId||!['saved','duplicate'].includes(r.status))throw Error('Preuve de vente enregistrée incohérente : rapprochement nécessaire.');
 }
 return stored;
}
/** Enregistrer l'aperçu avant confirmation, sans écriture métier. */
export async function prepareDaySaleAttempt(tx:Tx,identity:DeviceIdentity,input:NewSaleAttempt,digest:(text:string)=>Promise<string>){
 validAttempt(input);const existing=await readDaySaleAttempt(tx,identity);
 if(existing){if(canonicalJson(existing.attempt)!==canonicalJson(input))throw Error('Une autre vente attend confirmation ou vérification.');return existing;}
 assertDayInvoiceSyncIdle();await assertDayInvoiceAttemptExclusive(tx,identity);
 const draft=await captureNewDayInvoiceSale(tx,identity,input.clientId,input.day,input.lines,digest);
 if(input.fingerprint!==draft.fingerprint)throw Error('Facture ou solde modifié : vérifiez avant de confirmer.');
 const value:Stored={attempt:input,result:null};await tx.runAsync('INSERT INTO day_invoice_sale_attempt(id,commercial_id,server_origin,payload) VALUES(1,?,?,?)',identity.commercialId,identity.serverOrigin,JSON.stringify(value));return value;
}
/** Vente et reçu de confirmation sont commis ou annulés ensemble. */
export async function confirmDaySaleAttempt(tx:Tx,identity:DeviceIdentity,operationId:string,digest:(text:string)=>Promise<string>){
 const stored=await readDaySaleAttempt(tx,identity);if(!stored||stored.attempt.operationId!==operationId)throw Error('Tentative de vente absente ou différente.');
 if(stored.result)return {...stored.result,status:'duplicate' as const};
 assertDayInvoiceSyncIdle();await assertDayInvoiceAttemptExclusive(tx,identity,{kind:'sale',operationId});
 const result=await confirmNewDayInvoiceSale(tx,identity,stored.attempt,digest);
 await tx.runAsync('UPDATE day_invoice_sale_attempt SET payload=? WHERE id=1',JSON.stringify({...stored,result}));return result;
}
/** Le reçu n'est retiré qu'après lecture vérifiée et confirmation explicite. */
export async function acknowledgeDaySaleAttempt(tx:Tx,identity:DeviceIdentity,operationId:string){
 const stored=await readDaySaleAttempt(tx,identity);if(!stored||!stored.result||stored.attempt.operationId!==operationId)throw Error('Vente non confirmée ou reçu incohérent.');
 await tx.runAsync('DELETE FROM day_invoice_sale_attempt WHERE id=1');
}
/** Abandon explicite uniquement si aucun indice d'écriture n'existe. Ne jamais
 * utiliser pour effacer un reçu confirmé ou résoudre une incohérence. */
export async function cancelDaySaleAttempt(tx:Tx,identity:DeviceIdentity,operationId:string){
 const stored=await readDaySaleAttempt(tx,identity);if(!stored||stored.result||stored.attempt.operationId!==operationId)throw Error('Tentative non abandonnable.');
 const a=stored.attempt;
 const present=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM identified_local_operations WHERE lower(operation_id)=lower(?) OR lower(entity_id)=lower(?)) OR EXISTS(SELECT 1 FROM sales_outbox WHERE lower(operation_id)=lower(?) OR lower(sale_id)=lower(?)) OR EXISTS(SELECT 1 FROM journal_sync_outbox WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_payments WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_old_debt_local WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM offline_credit_prototype WHERE lower(operation_id)=lower(?)) AS n`,a.operationId,a.saleId,a.operationId,a.saleId,a.operationId,a.operationId,a.operationId,a.operationId);
 if(!present||present.n)throw Error('Trace de vente existante : rapprochement nécessaire.');
 const sales=await tx.getAllAsync<{payload:string}>('SELECT payload FROM sales');for(const row of sales){let sale:any;try{sale=JSON.parse(row.payload);}catch{throw Error('Vente locale illisible.');}if(typeof sale?.syncSaleId==='string'&&sale.syncSaleId.toLowerCase()===a.saleId.toLowerCase())throw Error('Trace de vente existante : rapprochement nécessaire.');}
 const ref=await readDayInvoiceReferenceCache(tx,identity);if(!ref||ref.saleStates?.some(s=>s.saleId.toLowerCase()===a.saleId.toLowerCase())||ref.dayPayments.some(p=>p.operationId.toLowerCase()===a.operationId.toLowerCase())||ref.settlementStates?.some(s=>s.operationId.toLowerCase()===a.operationId.toLowerCase()))throw Error('Référence ou trace serveur incohérente : rapprochement nécessaire.');
 await tx.runAsync('DELETE FROM day_invoice_sale_attempt WHERE id=1');
}
