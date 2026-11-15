import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';import {tourCloseQueueSchema} from '../../../apps/mobile/tour-close-queue.js';import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';import {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference} from '../../../apps/mobile/day-invoice-reference-cache.js';import {dayInvoiceQueueSchema} from '../../../apps/mobile/day-invoice-queue.js';import {saleEventTimeSchema} from '../../../apps/mobile/sale-event-time.js';
import {captureNewDayInvoiceSale,confirmNewDayInvoiceSale} from '../../../apps/mobile/day-invoice-sale-create.js';import {captureDayInvoiceForm,confirmDayInvoiceForm} from '../../../apps/mobile/day-invoice-form.js';import {readDayInvoiceClients} from '../../../apps/mobile/day-invoice-clients.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',invoiceId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',saleId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',operationId='11111111-1111-4111-8111-111111111111',paymentId='22222222-2222-4222-8222-222222222222';
const identity={commercialId:clientId,serverOrigin:'https://example.test'},day='2026-01-01',at='2026-01-01T09:00:00.000Z',digest=async(s:string)=>createHash('sha256').update(s).digest('hex');
const line={name:'Produit',code:'X',quantity:1,unitPrice:210084,discount:0,vat:1900};
const reference={version:6,clients:[{id:clientId,name:'Client',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'0'}],articles:[{id:'33333333-3333-4333-8333-333333333333',code:'X',name:'Produit',barcode:'',saleTtc:'250000',vatRate:1900,unitsPerCarton:1}],saleStates:[],saleDays:[],settlementStates:[],settlementDays:[],settlementProofs:[],oldDebtMarkers:[],journalStates:[{id:invoiceId,clientId,journalDate:day,total:600000,receipts:[],declaredByDayPayment:false}],journalProofs:[{id:invoiceId,version:1,hash:'a'.repeat(64)}],dayPayments:[]};
function setup(){const db=new DatabaseSync(':memory:');db.exec(`${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}${saleEventTimeSchema}
 CREATE TABLE sales(id INTEGER PRIMARY KEY,created_at TEXT,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
 CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);
 CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);`);
 db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);
 const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};return {db,tx};}
test('vente sur place v6 : facture 600 + 250, règlement unique 200 et solde 650',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  const draft=await captureNewDayInvoiceSale(tx,identity,clientId,day,[line],digest);assert.equal(draft.total,250000);assert.equal(draft.invoiceTotal,850000);assert.equal(draft.balanceAfter,250000);
  const input={clientId,day,lines:[line],fingerprint:draft.fingerprint,saleId,operationId,createdAt:at};
  db.exec('BEGIN');const saved=await confirmNewDayInvoiceSale(tx,identity,input,digest);db.exec('COMMIT');assert.equal(saved.sale.paid,0);assert.equal(saved.sale.remaining,250000);
  const form=await captureDayInvoiceForm(tx,identity,clientId,day,digest);assert.equal(form.view.total,850000);assert.equal(form.view.remaining,850000);
  db.exec('BEGIN');await confirmDayInvoiceForm(tx,identity,{clientId,day,fingerprint:form.fingerprint,operationId:paymentId,recordedAt:'2026-01-01T10:00:00.000Z',amount:200000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''},digest);db.exec('COMMIT');
  assert.equal((await captureDayInvoiceForm(tx,identity,clientId,day,digest)).view.remaining,650000);assert.equal((await readDayInvoiceClients(tx,identity,digest)).clients[0].balance,650000);
  await assert.rejects(captureNewDayInvoiceSale(tx,identity,clientId,day,[line],digest),/Règlement de cette facture en attente/);
  await assert.rejects(confirmNewDayInvoiceSale(tx,identity,input,digest),/Règlement de cette facture en attente/);
 }finally{db.close();}
});
test('vente sur place v6 : limite, prix, fraîcheur, collisions et atomicité',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  await assert.rejects(captureNewDayInvoiceSale(tx,{...identity,serverOrigin:'https://other.test'},clientId,day,[line],digest),/Identité/);
  await assert.rejects(captureNewDayInvoiceSale(tx,identity,clientId,day,[{...line,unitPrice:1}],digest),/Article/);
  const draft=await captureNewDayInvoiceSale(tx,identity,clientId,day,[line],digest),input={clientId,day,lines:[line],fingerprint:draft.fingerprint,saleId,operationId,createdAt:at};
  await assert.rejects(confirmNewDayInvoiceSale(tx,identity,{...input,fingerprint:'stale'},digest),/modifié/);
  await assert.rejects(confirmNewDayInvoiceSale(tx,identity,{...input,createdAt:'2026-01-01T23:30:00.000Z'},digest),/date/);
  const fail={...tx,runAsync:async(sql:string,...args:(string|number|null)[])=>{if(sql.startsWith('INSERT INTO sales_outbox'))throw Error('échec simulé');await tx.runAsync(sql,...args);}};
  db.exec('BEGIN');await assert.rejects(confirmNewDayInvoiceSale(fail,identity,input,digest),/échec simulé/);db.exec('ROLLBACK');assert.equal(db.prepare('SELECT count(*) n FROM sales').get()?.n,0);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,0);
  db.exec('BEGIN');await confirmNewDayInvoiceSale(tx,identity,input,digest);db.exec('COMMIT');
  await assert.rejects(confirmNewDayInvoiceSale(tx,identity,input,digest),/modifié/);
  const fresh=await captureNewDayInvoiceSale(tx,identity,clientId,day,[line],digest);
  await assert.rejects(confirmNewDayInvoiceSale(tx,identity,{...input,fingerprint:fresh.fingerprint},digest),/déjà utilisé/);
  await saveDayInvoiceReference(tx,identity,identity,{...reference,clients:[{...reference.clients[0],serverBalance:'100000',creditLimit:'100000'}]});
  await assert.rejects(captureNewDayInvoiceSale(tx,identity,clientId,day,[line],digest),/Limite/);
 }finally{db.close();}
});
