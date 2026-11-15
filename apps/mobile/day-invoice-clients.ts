/** Capture expérimentale des clients et soldes v6 dans une transaction
 * exclusive. Ne contourne pas la garde des anciens écrans. */
import {canonicalJson,isSaleBlocked} from '@sls/domain';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {reconcileDayInvoiceClient} from './day-invoice-reference';
import {readOldDebtOutbox} from './day-invoice-old-debt-queue';
import {readDayInvoiceOutbox} from './day-invoice-queue';
import {readIdentifiedOutbox} from './identified-outbox';
import {assertLegacyMobileCreditSafe} from './credit-note-write-guard-prototype';
import {validateDayPayment,type DayInvoicePayment} from '../../packages/domain/src/day-invoice';
import type {DeviceIdentity} from './identified-device';
import type {SavedSale,Settlement,TourPreInvoice,TourJournalReceipt} from './storage';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
function object(raw:string):Record<string,any>{let value:unknown;try{value=JSON.parse(raw);}catch{throw Error('Donnée locale illisible.');}if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Donnée locale illisible.');return value as Record<string,any>;}
export async function readDayInvoiceClients(tx:Tx,identity:DeviceIdentity,digest:(text:string)=>Promise<string>){
 await assertLegacyMobileCreditSafe(tx,identity);
 const ref=await readDayInvoiceReferenceCache(tx,identity);if(!ref||!ref.saleStates||!ref.settlementStates||!ref.journalStates)throw Error('Référence facture du jour indisponible.');
 const sourceQueue=await readIdentifiedOutbox(tx,identity),dayQueue=await readDayInvoiceOutbox(tx,identity),debtQueue=await readOldDebtOutbox(tx,identity);
 const queueSales=new Map<string,Record<string,any>>(),queueJournals=new Map<string,Record<string,any>>(),queueSettlements=new Map<string,Record<string,any>>();
 for(const item of sourceQueue){const event=object(item.payload);if(event.operationId!==item.operationId)throw Error('File locale incohérente.');
  if(item.kind==='sale'){const sale=event.sale;if(event.saleId!==item.entityId||!sale||sale.syncSaleId!==item.entityId||sale.syncVersion!==event.version)throw Error('Vente en attente incohérente.');const previous=queueSales.get(item.entityId);if(!previous||previous.version<event.version)queueSales.set(item.entityId,event);}
  else if(item.kind==='journal'){if(event.invoice?.id!==item.entityId)throw Error('Journal en attente incohérent.');const previous=queueJournals.get(item.entityId);if(!previous||previous.version<event.version)queueJournals.set(item.entityId,event);}
  else {if(event.settlement?.syncOperationId!==item.operationId)throw Error('Règlement en attente incohérent.');queueSettlements.set(item.operationId,event.settlement);}
 }
 for(const entry of debtQueue){const event=object(entry.payload),settlement=event.event?.settlement;if(!settlement||queueSettlements.has(entry.operationId))throw Error('Règlement en attente incohérent.');queueSettlements.set(entry.operationId,settlement);}
 const known=new Set(ref.clients.map(c=>c.id));
 const sales:SavedSale[]=[];
 for(const row of await tx.getAllAsync<{id:number;clientId:string;payload:string}>('SELECT id,client_id AS clientId,payload FROM sales ORDER BY id')){
  const s=object(row.payload);if(s.clientId!==row.clientId||!known.has(row.clientId)||'id' in s||typeof s.syncSaleId!=='string'||!Number.isSafeInteger(s.syncVersion)||s.syncVersion<1)throw Error('Vente locale non synchronisable.');
  const server=ref.saleStates.find(x=>x.saleId===s.syncSaleId),queued=queueSales.get(s.syncSaleId);
  if(server&&(server.clientId!==s.clientId||server.version>s.syncVersion||(server.version===s.syncVersion&&(server.total!==String(s.total)||server.paid!==String(s.paid)))))throw Error('Vente locale et serveur incohérentes.');
  if(!server||server.version<s.syncVersion){if(!queued||queued.version!==s.syncVersion||canonicalJson(queued.sale)!==canonicalJson(s))throw Error('Version de vente en attente indisponible.');}
  sales.push({...s,id:row.id} as SavedSale);
 }
 const settlements:Settlement[]=[];
 for(const row of await tx.getAllAsync<{id:number;clientId:string;payload:string}>('SELECT id,client_id AS clientId,payload FROM settlements ORDER BY id')){
  const p=object(row.payload);if(p.clientId!==row.clientId||!known.has(row.clientId)||typeof p.syncOperationId!=='string'||'id' in p)throw Error('Règlement local non synchronisable.');
  const server=ref.settlementStates.find(x=>x.operationId===p.syncOperationId);if(server&&server.clientId!==p.clientId)throw Error('Règlement attribué à un autre client.');
  if(server){const proof=ref.settlementProofs.find(x=>x.operationId===p.syncOperationId);if(!proof||await digest(canonicalJson(p))!==proof.hash)throw Error('Preuve de règlement local incohérente.');}
  else if(canonicalJson(queueSettlements.get(p.syncOperationId)??null)!==canonicalJson(p))throw Error('Règlement en attente indisponible.');
  settlements.push({...p,id:row.id} as Settlement);
 }
 const rows=await tx.getAllAsync<{id:string;clientId:string;day:string;payload:string}>('SELECT id,client_id AS clientId,journal_date AS day,payload FROM tour_pre_invoices ORDER BY rowid');
 const invoices: (TourPreInvoice&{version:number;receipts:TourJournalReceipt[]})[]=[];
 const states=await tx.getAllAsync<{invoiceId:string;version:number;payload:string}>('SELECT invoice_id AS invoiceId,version,payload FROM journal_sync_state');
 if(states.some(s=>!rows.some(r=>r.id===s.invoiceId)))throw Error('Version de journal sans facture.');
 const allReceipts=await tx.getAllAsync<{id:string;invoiceId:string;clientId:string;day:string;payload:string}>('SELECT id,pre_invoice_id AS invoiceId,client_id AS clientId,journal_date AS day,payload FROM tour_journal_receipts ORDER BY rowid');
 if(allReceipts.some(r=>!rows.some(i=>i.id===r.invoiceId)))throw Error('Règlement sans facture locale.');
 for(const row of rows){
  const invoice=object(row.payload),state=states.find(s=>s.invoiceId===row.id);if(!known.has(row.clientId)||invoice.id!==row.id||invoice.clientId!==row.clientId||invoice.journalDate!==row.day||!state||!Number.isSafeInteger(state.version)||state.version<1)throw Error('Facture locale incohérente.');
  const receipts=allReceipts.filter(r=>r.invoiceId===row.id).map(r=>{const p=object(r.payload);if(p.id!==r.id||p.preInvoiceId!==row.id||p.clientId!==row.clientId||p.journalDate!==row.day)throw Error('Reçu local incohérent.');return p as TourJournalReceipt;});
  const snapshot=object(state.payload);if(snapshot.version!==state.version||canonicalJson(snapshot.invoice)!==canonicalJson(invoice)||canonicalJson(snapshot.receipts)!==canonicalJson(receipts))throw Error('Version du journal locale incohérente.');
  const server=ref.journalStates.find(j=>j.id===row.id),proof=ref.journalProofs.find(p=>p.id===row.id);
  if(server&&(server.clientId!==row.clientId||server.journalDate!==row.day||server.total!==invoice.amount||!proof||proof.version>state.version))throw Error('Facture locale et serveur incohérentes.');
  if(server&&proof?.version===state.version){if(await digest(canonicalJson(snapshot))!==proof.hash)throw Error('Preuve de facture locale incohérente.');}
  else {const queued=queueJournals.get(row.id);if(!queued||canonicalJson(queued)!==canonicalJson(snapshot))throw Error('Version de journal en attente indisponible.');}
  invoices.push({...invoice,version:state.version,receipts} as TourPreInvoice&{version:number;receipts:TourJournalReceipt[]});
 }
 const dayPayments:DayInvoicePayment[]=[];
 for(const row of await tx.getAllAsync<{operationId:string;clientId:string;day:string;payload:string;commercialId:string;serverOrigin:string}>('SELECT operation_id AS operationId,client_id AS clientId,invoice_day AS day,payload,commercial_id AS commercialId,server_origin AS serverOrigin FROM day_invoice_payments ORDER BY operation_id LIMIT 20001')){
  const p=object(row.payload) as DayInvoicePayment;validateDayPayment(p);
  if(p.operationId!==row.operationId||p.clientId!==row.clientId||p.day!==row.day||row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin||!known.has(p.clientId))throw Error('Paiement unifié local incohérent.');dayPayments.push(p);
 }
 if(dayPayments.length>20000)throw Error('Historique de paiements incomplet.');
 const clients=ref.clients.map(client=>{try{const result=reconcileDayInvoiceClient({reference:ref,clientId:client.id,localSales:sales,localSettlements:settlements,localInvoices:invoices,localDayPayments:dayPayments});const limit=Number(client.creditLimit);return {...client,balance:result.balance,conflict:false as const,saleBlocked:isSaleBlocked(result.balance,limit,false),pendingDayPayments:result.pendingAmount};}catch{return {...client,balance:null,conflict:true as const,saleBlocked:true,pendingDayPayments:null};}});
 return {version:6 as const,clients,articles:ref.articles,pendingOperations:sourceQueue.length+dayQueue.length+debtQueue.length};
}
