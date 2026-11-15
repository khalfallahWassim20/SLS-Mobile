import {test} from 'node:test';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';import {tourCloseQueueSchema} from '../../../apps/mobile/tour-close-queue.js';import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';import {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference} from '../../../apps/mobile/day-invoice-reference-cache.js';import {dayInvoiceQueueSchema} from '../../../apps/mobile/day-invoice-queue.js';import {saleEventTimeSchema} from '../../../apps/mobile/sale-event-time.js';
import {dayInvoiceSaleAttemptSchema,readDaySaleAttempt,prepareDaySaleAttempt,confirmDaySaleAttempt,acknowledgeDaySaleAttempt,cancelDaySaleAttempt} from '../../../apps/mobile/day-invoice-sale-attempt.js';
import {captureNewDayInvoiceSale,confirmNewDayInvoiceSale} from '../../../apps/mobile/day-invoice-sale-create.js';import {captureDayInvoiceForm,confirmDayInvoiceForm} from '../../../apps/mobile/day-invoice-form.js';import {readDayInvoiceClients} from '../../../apps/mobile/day-invoice-clients.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',invoiceId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',saleId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',operationId='11111111-1111-4111-8111-111111111111',paymentId='22222222-2222-4222-8222-222222222222';
const identity={commercialId:clientId,serverOrigin:'https://example.test'},day='2026-01-01',at='2026-01-01T09:00:00.000Z',digest=async(s:string)=>createHash('sha256').update(s).digest('hex');
const line={name:'Produit',code:'X',quantity:1,unitPrice:210084,discount:0,vat:1900};
const reference={version:6,clients:[{id:clientId,name:'Client',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'0'}],articles:[{id:'33333333-3333-4333-8333-333333333333',code:'X',name:'Produit',barcode:'',saleTtc:'250000',vatRate:1900,unitsPerCarton:1}],saleStates:[],saleDays:[],settlementStates:[],settlementDays:[],settlementProofs:[],oldDebtMarkers:[],journalStates:[{id:invoiceId,clientId,journalDate:day,total:600000,receipts:[],declaredByDayPayment:false}],journalProofs:[{id:invoiceId,version:1,hash:'a'.repeat(64)}],dayPayments:[]};
function wrap(db:DatabaseSync){return {getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};}
function setup(path=':memory:'){const db=new DatabaseSync(path);db.exec(`${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}${saleEventTimeSchema}${dayInvoiceSaleAttemptSchema}
 CREATE TABLE sales(id INTEGER PRIMARY KEY,created_at TEXT,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
 CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);
 CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);`);
 db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);
 const tx=wrap(db);return {db,tx};}
test('vente sur place v6 : facture 600 + 250, règlement unique 200 et solde 650',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  const draft=await captureNewDayInvoiceSale(tx,identity,clientId,day,[line],digest);assert.equal(draft.total,250000);assert.equal(draft.invoiceTotal,850000);assert.equal(draft.balanceAfter,250000);
  const input={clientId,day,lines:[line],fingerprint:draft.fingerprint,saleId,operationId,createdAt:at};
  db.exec('BEGIN');const saved=await confirmNewDayInvoiceSale(tx,identity,input,digest);db.exec('COMMIT');assert.equal(saved.sale.paid,0);assert.equal(saved.sale.remaining,250000);
  const form=await captureDayInvoiceForm(tx,identity,clientId,day,digest);assert.equal(form.view.total,850000);assert.equal(form.view.remaining,850000);
  db.exec('BEGIN');await confirmDayInvoiceForm(tx,identity,{clientId,day,fingerprint:form.fingerprint,operationId:paymentId,recordedAt:'2026-01-01T10:00:00.000Z',amount:200000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''},digest);db.exec('COMMIT');
  assert.equal((await captureDayInvoiceForm(tx,identity,clientId,day,digest)).view.remaining,650000);assert.equal((await readDayInvoiceClients(tx,identity,digest)).clients[0].balance,650000);
  await assert.rejects(captureNewDayInvoiceSale(tx,identity,clientId,day,[line],digest),/Règlement de cette facture en attente/);
  assert.equal((await confirmNewDayInvoiceSale(tx,identity,input,digest)).status,'duplicate');
  assert.equal(db.prepare('SELECT count(*) n FROM sales').get()?.n,1);
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
  assert.equal((await confirmNewDayInvoiceSale(tx,identity,input,digest)).status,'duplicate');
  await assert.rejects(confirmNewDayInvoiceSale(tx,{...identity,serverOrigin:'https://other.test'},input,digest),/Identité/);
  await assert.rejects(confirmNewDayInvoiceSale(tx,identity,{...input,saleId:'99999999-9999-4999-8999-999999999999'},digest),/autres données/);
  await assert.rejects(confirmNewDayInvoiceSale(tx,identity,{...input,lines:[{...line,quantity:2}]},digest),/autres données/);
  const original=db.prepare('SELECT payload FROM sales_outbox').get()?.payload as string;db.prepare('UPDATE sales_outbox SET payload=?').run(original.replace('250000','250001'));
  await assert.rejects(confirmNewDayInvoiceSale(tx,identity,input,digest),/autres données/);db.prepare('UPDATE sales_outbox SET payload=?').run(original);
  db.prepare('DELETE FROM sales_outbox').run();await assert.rejects(confirmNewDayInvoiceSale(tx,identity,input,digest),/Preuve de vente/);
  db.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(operationId,saleId,1,original);
  await saveDayInvoiceReference(tx,identity,identity,{...reference,clients:[{...reference.clients[0],serverBalance:'100000',creditLimit:'100000'}]});
  await assert.rejects(captureNewDayInvoiceSale(tx,identity,clientId,day,[line],digest),/Limite/);
 }finally{db.close();}
});

test('tentative durable : redémarrage, rollback, preuve locale après synchronisation et accusé explicite',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-sale-attempt-')),path=join(dir,'phone.db');let {db,tx}=setup(path);
 try{
  await saveDayInvoiceReference(tx,identity,identity,reference);
  const draft=await captureNewDayInvoiceSale(tx,identity,clientId,day,[line],digest),input={clientId,day,lines:[line],fingerprint:draft.fingerprint,saleId,operationId,createdAt:at};
  await prepareDaySaleAttempt(tx,identity,input,digest);assert.equal((await readDaySaleAttempt(tx,identity))?.result,null);
  await assert.rejects(prepareDaySaleAttempt(tx,identity,{...input,operationId:paymentId},digest),/autre vente/);
  await assert.rejects(acknowledgeDaySaleAttempt(tx,identity,operationId),/non confirmée/);
  await assert.rejects(cancelDaySaleAttempt(tx,identity,paymentId),/abandonnable/);
  db.prepare("INSERT INTO identified_local_operations VALUES(?,?,'sale',?,?)").run(operationId,identity.commercialId,saleId,at);await assert.rejects(cancelDaySaleAttempt(tx,identity,operationId),/Trace/);db.prepare('DELETE FROM identified_local_operations WHERE operation_id=?').run(operationId);
  await cancelDaySaleAttempt(tx,identity,operationId);assert.equal(await readDaySaleAttempt(tx,identity),null);await prepareDaySaleAttempt(tx,identity,input,digest);
  db.close();db=new DatabaseSync(path);tx=wrap(db);
  assert.deepEqual((await readDaySaleAttempt(tx,identity))?.attempt,input);
  const failing={...tx,runAsync:async(sql:string,...args:(string|number|null)[])=>{if(sql.startsWith('UPDATE day_invoice_sale_attempt'))throw Error('panne avant reçu');await tx.runAsync(sql,...args);}};
  db.exec('BEGIN');await assert.rejects(confirmDaySaleAttempt(failing,identity,digest),/panne avant reçu/);db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) n FROM sales').get()?.n,0);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,0);assert.equal((await readDaySaleAttempt(tx,identity))?.result,null);
  db.exec('BEGIN');assert.equal((await confirmDaySaleAttempt(tx,identity,digest)).status,'saved');db.exec('COMMIT');
  db.close();db=new DatabaseSync(path);tx=wrap(db);
  await assert.rejects(cancelDaySaleAttempt(tx,identity,operationId),/abandonnable/);
  assert.equal((await confirmDaySaleAttempt(tx,identity,digest)).status,'duplicate');assert.equal(db.prepare('SELECT count(*) n FROM sales').get()?.n,1);
  // Simulation de retrait de la file après accusé : le reçu atomique reste lisible.
  db.prepare('DELETE FROM sales_outbox').run();assert.equal((await confirmDaySaleAttempt(tx,identity,digest)).status,'duplicate');
  await assert.rejects(readDaySaleAttempt(tx,{...identity,serverOrigin:'https://other.test'}),/Identité/);
  await assert.rejects(acknowledgeDaySaleAttempt(tx,identity,paymentId),/incohérent/);
  const raw=db.prepare('SELECT payload FROM day_invoice_sale_attempt').get()?.payload as string,corrupt=JSON.parse(raw);corrupt.result.sale.total++;db.prepare('UPDATE day_invoice_sale_attempt SET payload=?').run(JSON.stringify(corrupt));
  await assert.rejects(readDaySaleAttempt(tx,identity),/incohérente/);await assert.rejects(acknowledgeDaySaleAttempt(tx,identity,operationId),/incohérente/);
  db.prepare('UPDATE day_invoice_sale_attempt SET payload=?').run(raw);await acknowledgeDaySaleAttempt(tx,identity,operationId);assert.equal(await readDaySaleAttempt(tx,identity),null);assert.equal(db.prepare('SELECT count(*) n FROM sales').get()?.n,1);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
