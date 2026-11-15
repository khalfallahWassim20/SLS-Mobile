/** Création préparatoire d'une vente sur place dans le protocole de facture du
 * jour. Rien n'est encaissé sur la vente : le règlement porte sur la facture
 * combinée et reste un événement distinct. Transaction SQLite exclusive requise. */
import {canonicalJson,calculateInvoice} from '@sls/domain';
import {getDeviceIdentity,assertDeviceWritable,recordDeviceOperation,type DeviceIdentity} from './identified-device';
import {assertLegacyMobileCreditSafe} from './credit-note-write-guard-prototype';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {readDayInvoiceClients} from './day-invoice-clients';
import {readDayInvoiceOutbox} from './day-invoice-queue';
import {readOldDebtOutbox} from './day-invoice-old-debt-queue';
import {captureDayInvoiceForm} from './day-invoice-form';
import {recordSaleEventTime} from './sale-event-time';
import {unitPriceExcludingVat} from './reference';
import {tunisDay} from './journal';
import type {SavedSale} from './storage';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type Line=SavedSale['lines'][number];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys='code,discount,name,quantity,unitPrice,vat';
export async function captureNewDayInvoiceSale(tx:Tx,identity:DeviceIdentity,clientId:string,day:string,lines:Line[],digest:(text:string)=>Promise<string>){
 const bound=await getDeviceIdentity(tx);if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur incohérent.');
 if(typeof clientId!=='string'||!uuid.test(clientId)||typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('Client ou journée invalide.');
 const date=new Date(`${day}T00:00:00.000Z`);if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day)throw Error('Journée invalide.');
 await assertLegacyMobileCreditSafe(tx,identity);await assertDeviceWritable(tx,identity,[day]);
 const ref=await readDayInvoiceReferenceCache(tx,identity);if(!ref)throw Error('Référence facture du jour indisponible.');
 // Les sources sont envoyées avant les paiements ; ajouter une vente après
 // un paiement local non envoyé invaliderait sa preuve de sources.
 for(const entry of await readDayInvoiceOutbox(tx,identity)){const p=JSON.parse(entry.payload);if(p.clientId.toLowerCase()===clientId.toLowerCase()&&p.day===day)throw Error('Règlement de cette facture en attente : synchronisez avant d’ajouter une vente.');}
 for(const entry of await readOldDebtOutbox(tx,identity)){const p=JSON.parse(entry.payload);if(p.event.settlement.clientId.toLowerCase()===clientId.toLowerCase())throw Error('Règlement de dette en attente : synchronisez avant d’ajouter une vente.');}
 if(ref.oldDebtMarkers.some(m=>m.invoiceDay>day&&ref.settlementStates?.some(s=>s.operationId.toLowerCase()===m.operationId.toLowerCase()&&s.clientId.toLowerCase()===clientId.toLowerCase())))throw Error('Règlement de dette ultérieur : rapprochement nécessaire.');
 const clients=await readDayInvoiceClients(tx,identity,digest),client=clients.clients.find(c=>c.id===clientId);
 if(!client||client.conflict||client.balance===null)throw Error('Client ou solde indisponible.');
 if(client.saleBlocked)throw Error('Limite de crédit atteinte : vente bloquée.');
 if(!Array.isArray(lines)||lines.length<1||lines.length>200)throw Error('La vente doit contenir entre 1 et 200 articles.');
 const catalog=new Map<string,(typeof ref.articles)[number]|null>();for(const article of ref.articles)catalog.set(article.code,catalog.has(article.code)?null:article);
 const seen=new Set<string>(),clean=lines.map(line=>{
  if(!line||typeof line!=='object'||Array.isArray(line)||Object.keys(line).sort().join(',')!==keys)throw Error('Article invalide.');
  const article=catalog.get(line.code);if(!article||seen.has(line.code)||line.name!==article.name||line.unitPrice!==unitPriceExcludingVat(article.saleTtc,article.vatRate)||line.vat!==article.vatRate||!Number.isSafeInteger(line.quantity)||line.quantity<1||line.quantity>1000000||!Number.isSafeInteger(line.discount)||line.discount<0||line.discount>10000)throw Error('Article, prix, quantité ou remise invalide.');
  seen.add(line.code);return {...line};
 });
 const total=calculateInvoice(clean.map(l=>({quantity:l.quantity,unitPrice:l.unitPrice,discountRate:l.discount,vatRate:l.vat}))).total;
 const balance=BigInt(client.balance)+BigInt(total);if(balance>BigInt(Number.MAX_SAFE_INTEGER)||balance<BigInt(Number.MIN_SAFE_INTEGER))throw Error('Solde trop élevé.');
 const invoice=await captureDayInvoiceForm(tx,identity,clientId,day,digest),invoiceTotal=BigInt(invoice.view.total)+BigInt(total);
 if(invoiceTotal>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Facture trop élevée.');
 const fingerprint=canonicalJson({clientId,day,clientName:client.name,balance:client.balance,creditLimit:client.creditLimit,invoice:invoice.fingerprint,lines:clean});
 return {clientId,clientName:client.name,day,lines:clean,total,balanceBefore:client.balance,balanceAfter:Number(balance),invoiceTotal:Number(invoiceTotal),fingerprint};
}
export async function confirmNewDayInvoiceSale(tx:Tx,identity:DeviceIdentity,input:{clientId:string;day:string;lines:Line[];fingerprint:string;saleId:string;operationId:string;createdAt:string},digest:(text:string)=>Promise<string>){
 if(!uuid.test(input.saleId)||!uuid.test(input.operationId)||input.saleId.toLowerCase()===input.operationId.toLowerCase()||typeof input.createdAt!=='string'||!Number.isFinite(Date.parse(input.createdAt))||new Date(input.createdAt).toISOString()!==input.createdAt||tunisDay(new Date(input.createdAt))!==input.day)throw Error('Identifiant ou date de vente invalide.');
 const current=await captureNewDayInvoiceSale(tx,identity,input.clientId,input.day,input.lines,digest);
 if(current.fingerprint!==input.fingerprint)throw Error('Facture ou solde modifié : vérifiez avant de confirmer.');
 const ref=await readDayInvoiceReferenceCache(tx,identity);if(!ref)throw Error('Référence indisponible.');
 if(ref.saleStates?.some(s=>s.saleId.toLowerCase()===input.saleId.toLowerCase())||ref.dayPayments.some(p=>p.operationId.toLowerCase()===input.operationId.toLowerCase())||ref.settlementStates?.some(s=>s.operationId.toLowerCase()===input.operationId.toLowerCase()))throw Error('Identifiant de vente déjà utilisé.');
 const rows=await tx.getAllAsync<{payload:string}>('SELECT payload FROM sales');for(const row of rows){let s:any;try{s=JSON.parse(row.payload);}catch{throw Error('Vente locale illisible.');}if(typeof s.syncSaleId==='string'&&s.syncSaleId.toLowerCase()===input.saleId.toLowerCase())throw Error('Identifiant de vente déjà utilisé.');}
 const collision=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM identified_local_operations WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_payments WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_old_debt_local WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM offline_credit_prototype WHERE lower(operation_id)=lower(?)) AS n`,input.operationId,input.operationId,input.operationId,input.operationId);
 if(!collision||collision.n)throw Error('Identifiant d’opération déjà utilisé.');
 const sale:Omit<SavedSale,'id'>={createdAt:input.createdAt,clientId:input.clientId,clientName:current.clientName,syncSaleId:input.saleId,syncVersion:1,lines:current.lines,total:current.total,paid:0,remaining:current.total,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
 const event={operationId:input.operationId,saleId:input.saleId,version:1,sale,refund:0};
 await tx.runAsync('INSERT INTO sales(created_at,client_id,payload) VALUES(?,?,?)',sale.createdAt,sale.clientId,JSON.stringify(sale));
 await tx.runAsync('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)',input.operationId,input.saleId,1,JSON.stringify(event));
 await recordSaleEventTime(tx,input.operationId,input.createdAt);await recordDeviceOperation(tx,identity,input.operationId,'sale',input.saleId,input.createdAt);
 return {sale,operationId:input.operationId,balanceAfter:current.balanceAfter};
}
