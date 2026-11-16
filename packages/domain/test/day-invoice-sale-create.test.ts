import {dayInvoicePreinvoiceAttemptSchema,readPreinvoiceAttempt,preparePreinvoiceAttempt,confirmPreinvoiceAttempt,acknowledgePreinvoiceAttempt,cancelPreinvoiceAttempt} from '../../../apps/mobile/day-invoice-preinvoice-attempt.js';
import {startPreinvoiceAttempt,resumePreinvoiceAttempt,finishPreinvoiceAttempt,abandonPreinvoiceAttempt} from '../../../apps/mobile/day-invoice-preinvoice-attempt-flow.js';
import {captureNewDayPreinvoice,confirmNewDayPreinvoice} from '../../../apps/mobile/day-invoice-preinvoice-create.js';
import {test} from 'node:test';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';import {tourCloseQueueSchema} from '../../../apps/mobile/tour-close-queue.js';import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';import {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference} from '../../../apps/mobile/day-invoice-reference-cache.js';import {dayInvoiceQueueSchema} from '../../../apps/mobile/day-invoice-queue.js';import {saleEventTimeSchema} from '../../../apps/mobile/sale-event-time.js';
import {dayInvoicePaymentAttemptSchema,readDayPaymentAttempt,prepareDayPaymentAttempt,confirmDayPaymentAttempt,acknowledgeDayPaymentAttempt,cancelDayPaymentAttempt} from '../../../apps/mobile/day-invoice-payment-attempt.js';
import {dayInvoiceSaleAttemptSchema,readDaySaleAttempt,prepareDaySaleAttempt,confirmDaySaleAttempt,acknowledgeDaySaleAttempt,cancelDaySaleAttempt} from '../../../apps/mobile/day-invoice-sale-attempt.js';
import {assertDayInvoiceAttemptsSettled} from '../../../apps/mobile/day-invoice-attempt-guard.js';import {synchronizeDayInvoicePrototype} from '../../../apps/mobile/day-invoice-sync.js';import {captureDayInvoiceClose} from '../../../apps/mobile/day-invoice-close-capture.js';import {assertLegacyMobileDayInvoiceSafe} from '../../../apps/mobile/day-invoice-legacy-guard.js';
import {captureNewDayInvoiceSale,confirmNewDayInvoiceSale} from '../../../apps/mobile/day-invoice-sale-create.js';import {captureDayInvoiceForm,confirmDayInvoiceForm} from '../../../apps/mobile/day-invoice-form.js';import {readDayInvoiceClients} from '../../../apps/mobile/day-invoice-clients.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',invoiceId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',saleId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',operationId='11111111-1111-4111-8111-111111111111',paymentId='22222222-2222-4222-8222-222222222222';
const identity={commercialId:clientId,serverOrigin:'https://example.test'},day='2026-01-01',at='2026-01-01T09:00:00.000Z',digest=async(s:string)=>createHash('sha256').update(s).digest('hex');
const line={name:'Produit',code:'X',quantity:1,unitPrice:210084,discount:0,vat:1900};
const reference={version:6,clients:[{id:clientId,name:'Client',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'0'}],articles:[{id:'33333333-3333-4333-8333-333333333333',code:'X',name:'Produit',barcode:'',saleTtc:'250000',vatRate:1900,unitsPerCarton:1}],saleStates:[],saleDays:[],settlementStates:[],settlementDays:[],settlementProofs:[],oldDebtMarkers:[],journalStates:[{id:invoiceId,clientId,journalDate:day,total:600000,receipts:[],declaredByDayPayment:false}],journalProofs:[{id:invoiceId,version:1,hash:'a'.repeat(64)}],dayPayments:[]};
function wrap(db:DatabaseSync){return {getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};}
function setup(path=':memory:'){const db=new DatabaseSync(path);db.exec(`${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}${saleEventTimeSchema}${dayInvoiceSaleAttemptSchema}${dayInvoicePaymentAttemptSchema}${dayInvoicePreinvoiceAttemptSchema}
 CREATE TABLE sales(id INTEGER PRIMARY KEY,created_at TEXT,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
 CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,version INTEGER,payload TEXT);
 CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT PRIMARY KEY,version INTEGER,payload TEXT);`);
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
  db.exec('BEGIN');await assert.rejects(confirmDaySaleAttempt(failing,identity,operationId,digest),/panne avant reçu/);db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) n FROM sales').get()?.n,0);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,0);assert.equal((await readDaySaleAttempt(tx,identity))?.result,null);
  await assert.rejects(confirmDaySaleAttempt(tx,identity,paymentId,digest),/différente/);
  assert.equal(db.prepare('SELECT count(*) n FROM sales').get()?.n,0);
  db.exec('BEGIN');assert.equal((await confirmDaySaleAttempt(tx,identity,operationId,digest)).status,'saved');db.exec('COMMIT');
  db.close();db=new DatabaseSync(path);tx=wrap(db);
  await assert.rejects(cancelDaySaleAttempt(tx,identity,operationId),/abandonnable/);
  assert.equal((await confirmDaySaleAttempt(tx,identity,operationId,digest)).status,'duplicate');assert.equal(db.prepare('SELECT count(*) n FROM sales').get()?.n,1);
  // Simulation de retrait de la file après accusé : le reçu atomique reste lisible.
  db.prepare('DELETE FROM sales_outbox').run();assert.equal((await confirmDaySaleAttempt(tx,identity,operationId,digest)).status,'duplicate');
  await assert.rejects(readDaySaleAttempt(tx,{...identity,serverOrigin:'https://other.test'}),/Identité/);
  await assert.rejects(acknowledgeDaySaleAttempt(tx,identity,paymentId),/incohérent/);
  const raw=db.prepare('SELECT payload FROM day_invoice_sale_attempt').get()?.payload as string,corrupt=JSON.parse(raw);corrupt.result.sale.total++;db.prepare('UPDATE day_invoice_sale_attempt SET payload=?').run(JSON.stringify(corrupt));
  await assert.rejects(readDaySaleAttempt(tx,identity),/incohérente/);await assert.rejects(acknowledgeDaySaleAttempt(tx,identity,operationId),/incohérente/);
  db.prepare('UPDATE day_invoice_sale_attempt SET payload=?').run(raw);await acknowledgeDaySaleAttempt(tx,identity,operationId);assert.equal(await readDaySaleAttempt(tx,identity),null);assert.equal(db.prepare('SELECT count(*) n FROM sales').get()?.n,1);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('règlement durable : reprise après redémarrage, transaction atomique et preuve après synchronisation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-payment-attempt-')),path=join(dir,'phone.db');let {db,tx}=setup(path);
 try{
  await saveDayInvoiceReference(tx,identity,identity,reference);
  const draft=await captureNewDayInvoiceSale(tx,identity,clientId,day,[line],digest),saleInput={clientId,day,lines:[line],fingerprint:draft.fingerprint,saleId,operationId,createdAt:at};
  await confirmNewDayInvoiceSale(tx,identity,saleInput,digest);
  const form=await captureDayInvoiceForm(tx,identity,clientId,day,digest),input={clientId,day,fingerprint:form.fingerprint,operationId:paymentId,recordedAt:'2026-01-01T10:00:00.000Z',amount:200000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:''};
  await assert.rejects(prepareDayPaymentAttempt(tx,identity,{...input,amount:900000},digest),/paiement|total|supérieur|dépasse/i);
  await prepareDayPaymentAttempt(tx,identity,input,digest);assert.equal((await readDayPaymentAttempt(tx,identity))?.result,null);
  await assert.rejects(prepareDayPaymentAttempt(tx,identity,{...input,amount:100000},digest),/autre règlement/);
  await assert.rejects(acknowledgeDayPaymentAttempt(tx,identity,paymentId),/non confirmé/);
  await assert.rejects(cancelDayPaymentAttempt(tx,identity,operationId),/abandonnable/);
  db.prepare("INSERT INTO identified_local_operations VALUES(?,?,'sale',?,?)").run(paymentId,identity.commercialId,saleId,at);await assert.rejects(cancelDayPaymentAttempt(tx,identity,paymentId),/Trace/);db.prepare('DELETE FROM identified_local_operations WHERE operation_id=?').run(paymentId);
  await cancelDayPaymentAttempt(tx,identity,paymentId);assert.equal(await readDayPaymentAttempt(tx,identity),null);await prepareDayPaymentAttempt(tx,identity,input,digest);
  db.close();db=new DatabaseSync(path);tx=wrap(db);assert.deepEqual((await readDayPaymentAttempt(tx,identity))?.attempt,input);
  const fail={...tx,runAsync:async(sql:string,...args:(string|number|null)[])=>{if(sql.startsWith('UPDATE day_invoice_payment_attempt'))throw Error('panne avant reçu');await tx.runAsync(sql,...args);}};
  db.exec('BEGIN');await assert.rejects(confirmDayPaymentAttempt(fail,identity,paymentId,digest),/panne avant reçu/);db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payments').get()?.n,0);assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payment_outbox').get()?.n,0);
  await assert.rejects(confirmDayPaymentAttempt(tx,identity,operationId,digest),/différente/);
  db.exec('BEGIN');assert.equal((await confirmDayPaymentAttempt(tx,identity,paymentId,digest)).status,'created');db.exec('COMMIT');
  db.close();db=new DatabaseSync(path);tx=wrap(db);assert.equal((await confirmDayPaymentAttempt(tx,identity,paymentId,digest)).status,'duplicate');
  assert.equal((await captureDayInvoiceForm(tx,identity,clientId,day,digest)).view.remaining,650000);
  db.prepare('DELETE FROM day_invoice_payment_outbox').run();assert.equal((await confirmDayPaymentAttempt(tx,identity,paymentId,digest)).status,'duplicate');
  await assert.rejects(cancelDayPaymentAttempt(tx,identity,paymentId),/abandonnable/);await assert.rejects(readDayPaymentAttempt(tx,{...identity,serverOrigin:'https://other.test'}),/Identité/);
  const original=db.prepare('SELECT payload FROM day_invoice_payment_attempt').get()?.payload as string,corrupt=JSON.parse(original);corrupt.result.payment.amount++;db.prepare('UPDATE day_invoice_payment_attempt SET payload=?').run(JSON.stringify(corrupt));
  await assert.rejects(readDayPaymentAttempt(tx,identity),/incohérente/);await assert.rejects(acknowledgeDayPaymentAttempt(tx,identity,paymentId),/incohérente/);
  db.prepare('UPDATE day_invoice_payment_attempt SET payload=?').run(original);await acknowledgeDayPaymentAttempt(tx,identity,paymentId);assert.equal(await readDayPaymentAttempt(tx,identity),null);assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payments').get()?.n,1);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('tentative durable : déclaration crédit seulement sur facture entièrement impayée',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  const form=await captureDayInvoiceForm(tx,identity,clientId,day,digest),input={clientId,day,fingerprint:form.fingerprint,operationId:paymentId,recordedAt:at,amount:0,mode:'Crédit' as const,chequeNumber:'',chequeBank:'',chequeDue:''};
  await prepareDayPaymentAttempt(tx,identity,input,digest);db.exec('BEGIN');await confirmDayPaymentAttempt(tx,identity,paymentId,digest);db.exec('COMMIT');
  assert.equal((await readDayPaymentAttempt(tx,identity))?.result?.payment.amount,0);assert.equal((await captureDayInvoiceForm(tx,identity,clientId,day,digest)).view.remaining,600000);
  await acknowledgeDayPaymentAttempt(tx,identity,paymentId);const after=await captureDayInvoiceForm(tx,identity,clientId,day,digest);
  await assert.rejects(prepareDayPaymentAttempt(tx,identity,{...input,operationId:'99999999-9999-4999-8999-999999999999',fingerprint:after.fingerprint},digest),/crédit|déclaration/i);
 }finally{db.close();}
});

test('tentatives v6 : synchronisation et clôture ne précèdent pas une décision inachevée',async()=>{
 const {db,tx}=setup();try{
  await saveDayInvoiceReference(tx,identity,identity,reference);
  const draft=await captureNewDayInvoiceSale(tx,identity,clientId,day,[line],digest),saleInput={clientId,day,lines:[line],fingerprint:draft.fingerprint,saleId,operationId,createdAt:at};
  await prepareDaySaleAttempt(tx,identity,saleInput,digest);
  await assert.rejects(assertDayInvoiceAttemptsSettled(tx,identity),/Vente en attente/);
  await assert.rejects(captureDayInvoiceClose(tx,identity,day,digest),/Vente en attente/);
  await assertDayInvoiceAttemptsSettled(tx,identity,'2026-01-02');
  let sends=0;const io={digest,transaction:async<T>(work:(t:typeof tx)=>Promise<T>)=>work(tx),verifyServer:async()=>{},check:()=>{},fetchReference:async()=>{sends++;return reference;},sendSource:async()=>{sends++;throw Error('ne doit pas envoyer');},sendPayment:async()=>{sends++;throw Error('ne doit pas envoyer');}};
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Vente en attente/);assert.equal(sends,0);
  db.exec('BEGIN');await confirmDaySaleAttempt(tx,identity,operationId,digest);db.exec('COMMIT');await assertDayInvoiceAttemptsSettled(tx,identity);
  const form=await captureDayInvoiceForm(tx,identity,clientId,day,digest),payment={clientId,day,fingerprint:form.fingerprint,operationId:paymentId,recordedAt:'2026-01-02T10:00:00.000Z',amount:200000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:''};
  db.prepare("INSERT INTO tour_known_server_states(commercial_id,journal_date,status,version) VALUES(?,?,'closed',1)").run(identity.commercialId,'2026-01-02');
  await assert.rejects(prepareDayPaymentAttempt(tx,identity,payment,digest),/clôturée/);db.prepare('DELETE FROM tour_known_server_states').run();
  await prepareDayPaymentAttempt(tx,identity,payment,digest);
  await assert.rejects(assertDayInvoiceAttemptsSettled(tx,identity),/Règlement en attente/);
  await assert.rejects(assertDayInvoiceAttemptsSettled(tx,identity,day),/Règlement en attente/);
  await assert.rejects(assertDayInvoiceAttemptsSettled(tx,identity,'2026-01-02'),/Règlement en attente/);
  await assertDayInvoiceAttemptsSettled(tx,identity,'2026-01-03');
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Règlement en attente/);assert.equal(sends,0);
  db.exec('BEGIN');await confirmDayPaymentAttempt(tx,identity,paymentId,digest);db.exec('COMMIT');await assertDayInvoiceAttemptsSettled(tx,identity);
  // Une preuve corrompue bloque même si le reçu est marqué confirmé.
  const original=db.prepare('SELECT payload FROM day_invoice_payment_attempt').get()?.payload as string,p=JSON.parse(original);p.result.payment.amount++;db.prepare('UPDATE day_invoice_payment_attempt SET payload=?').run(JSON.stringify(p));
  await assert.rejects(assertDayInvoiceAttemptsSettled(tx,identity),/incohérente/);db.prepare('UPDATE day_invoice_payment_attempt SET payload=?').run(original);
  db.prepare('DELETE FROM day_invoice_reference_cache').run();db.prepare('DELETE FROM day_invoice_payment_outbox').run();db.prepare('DELETE FROM day_invoice_payments').run();
  await assert.rejects(assertLegacyMobileDayInvoiceSafe(tx),/Tentative de facture du jour/);
 }finally{db.close();}
});
test('synchronisation en cours : aucune nouvelle intention v6 ne peut être préparée',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  const draft=await captureNewDayInvoiceSale(tx,identity,clientId,day,[line],digest),saleInput={clientId,day,lines:[line],fingerprint:draft.fingerprint,saleId,operationId,createdAt:at};
  const form=await captureDayInvoiceForm(tx,identity,clientId,day,digest),payment={clientId,day,fingerprint:form.fingerprint,operationId:paymentId,recordedAt:at,amount:200000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:''};
  let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  const io={digest,transaction:async<T>(work:(t:typeof tx)=>Promise<T>)=>work(tx),verifyServer:async()=>{entered();await wait;},check:()=>{},fetchReference:async()=>reference,sendSource:async()=>{throw Error('aucune source');},sendPayment:async()=>{throw Error('aucun paiement');}};
  const sync=synchronizeDayInvoicePrototype(identity,identity,io);await ready;
  try{await assert.rejects(prepareDaySaleAttempt(tx,identity,saleInput,digest),/Synchronisation en cours/);await assert.rejects(prepareDayPaymentAttempt(tx,identity,payment,digest),/Synchronisation en cours/);assert.equal(await readDaySaleAttempt(tx,identity),null);assert.equal(await readDayPaymentAttempt(tx,identity),null);}finally{release();}
  assert.deepEqual(await sync,{sources:0,payments:0,remainingSources:0,remainingPayments:0});
  await prepareDaySaleAttempt(tx,identity,saleInput,digest);assert.ok(await readDaySaleAttempt(tx,identity));
 }finally{db.close();}
});

test('synchronisation paiement unifié : accusé seul insuffisant, preuve et retrait atomiques',async()=>{
 const {db,tx}=setup();try{
  const transaction=async<T>(fn:(t:typeof tx)=>Promise<T>)=>{db.exec('BEGIN');try{const value=await fn(tx);db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
  await transaction(t=>saveDayInvoiceReference(t,identity,identity,reference));const form=await captureDayInvoiceForm(tx,identity,clientId,day,digest);
  const result=await transaction(t=>confirmDayInvoiceForm(t,identity,{clientId,day,fingerprint:form.fingerprint,operationId:paymentId,recordedAt:at,amount:200000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''},digest));
  const server={...reference,clients:[{...reference.clients[0],serverBalance:'400000'}],journalStates:[{...reference.journalStates[0],declaredByDayPayment:true}],dayPayments:[result.payment]};
  let calls=0,sends=0,mode:'cut'|'stale'|'ok'='cut';
  const io={transaction,digest,check:()=>{},verifyServer:async()=>{},fetchReference:async()=>{calls++;if(mode==='cut'&&calls===3)throw Error('référence interrompue');return mode==='ok'?server:reference;},sendSource:async()=>{throw Error('inattendu');},sendPayment:async()=>{sends++;return {ok:true,status:200,json:async()=>({status:sends===1?'received':'duplicate',operationId:paymentId})};}};
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/référence interrompue/);assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payment_outbox').get()?.n,1);
  mode='stale';await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Preuve serveur/);assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payment_outbox').get()?.n,1);
  mode='ok';assert.deepEqual(await synchronizeDayInvoicePrototype(identity,identity,io),{sources:0,payments:1,remainingSources:0,remainingPayments:0});assert.equal(sends,3);assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payment_outbox').get()?.n,0);
  assert.equal((await captureDayInvoiceForm(tx,identity,clientId,day,digest)).view.remaining,400000);assert.equal((await readDayInvoiceClients(tx,identity,digest)).clients[0].balance,400000);
 }finally{db.close();}
});

test('vente synchronisée : garder la file tant que les marqueurs serveur ne sont pas enregistrés',async()=>{
 const {db,tx}=setup();try{
  const transaction=async<T>(fn:(t:typeof tx)=>Promise<T>)=>{db.exec('BEGIN');try{const value=await fn(tx);db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
  await transaction(t=>saveDayInvoiceReference(t,identity,identity,reference));const draft=await captureNewDayInvoiceSale(tx,identity,clientId,day,[line],digest);
  await transaction(t=>confirmNewDayInvoiceSale(t,identity,{clientId,day,lines:[line],fingerprint:draft.fingerprint,saleId,operationId,createdAt:at},digest));
  const sale=JSON.parse(db.prepare('SELECT payload FROM sales').get()?.payload as string),{canonicalJson}=await import('@sls/domain'),hash=await digest(canonicalJson(sale));
  const server={...reference,clients:[{...reference.clients[0],serverBalance:'250000'}],saleStates:[{saleId,clientId,version:1,total:'250000',paid:'0'}],saleDays:[{saleId,clientId,day}],saleProofs:[{saleId,version:1,hash}]};
  let calls=0,sends=0,mode:'cut'|'stale'|'wrong'|'wrongHash'|'ok'='cut';
  const io={transaction,digest,check:()=>{},verifyServer:async()=>{},fetchReference:async()=>{calls++;if(mode==='cut'&&calls===2)throw Error('référence interrompue');if(mode==='wrong'&&calls>1)return {...server,saleStates:[{...server.saleStates[0],total:'249000'}]};if(mode==='wrongHash'&&calls>1)return {...server,saleProofs:[{saleId,version:1,hash:'b'.repeat(64)}]};return mode==='ok'?server:reference;},sendSource:async()=>{sends++;return {ok:true,status:200,json:async()=>({status:sends===1?'received':'duplicate',operationId})};},sendPayment:async()=>{throw Error('inattendu');}};
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/référence interrompue/);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,1);
  mode='stale';await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Marqueur serveur/);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,1);
  // La référence erronée n'est pas sauvegardée si la preuve échoue.
  mode='wrong';calls=0;await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Marqueur serveur/);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,1);
  mode='wrongHash';calls=0;await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Marqueur serveur/);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,1);
  mode='ok';assert.deepEqual(await synchronizeDayInvoicePrototype(identity,identity,io),{sources:1,payments:0,remainingSources:0,remainingPayments:0});assert.equal(sends,5);assert.equal((await readDayInvoiceClients(tx,identity,digest)).clients[0].balance,250000);
  db.prepare('UPDATE sales SET payload=?').run(JSON.stringify({...sale,lines:[{...sale.lines[0],name:'Autre produit'}]}));
  await assert.rejects(readDayInvoiceClients(tx,identity,digest),/Preuve de vente locale/);
 }finally{db.close();}
});

test('source règlement : le retrait exige la preuve exacte dans la référence',async()=>{
 const {db,tx}=setup();try{
  const transaction=async<T>(fn:(t:typeof tx)=>Promise<T>)=>{db.exec('BEGIN');try{const value=await fn(tx);db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
  await transaction(t=>saveDayInvoiceReference(t,identity,identity,reference));
  const settlement={syncOperationId:operationId,createdAt:at,clientId,clientName:'Client',amount:1000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''},event={operationId,settlement};
  db.prepare('INSERT INTO sales_outbox(operation_id,sale_id,payload) VALUES(?,?,?)').run(operationId,operationId,JSON.stringify(event));
  db.prepare("INSERT INTO identified_local_operations VALUES(?,?,'settlement',?,?)").run(operationId,identity.commercialId,operationId,at);
  const {canonicalJson}=await import('@sls/domain');const hash=await digest(canonicalJson(settlement));
  const server={...reference,clients:[{...reference.clients[0],serverBalance:'-1000'}],settlementStates:[{operationId,clientId}],settlementDays:[{operationId,clientId,day}],settlementProofs:[{operationId,hash}]};
  let mode:'stale'|'wrong'|'ok'='stale',calls=0;
  const io={transaction,digest,check:()=>{},verifyServer:async()=>{},fetchReference:async()=>{calls++;if(mode==='wrong'&&calls>1)return {...server,settlementProofs:[{operationId,hash:'b'.repeat(64)}]};return mode==='ok'?server:reference;},sendSource:async()=>({ok:true,status:200,json:async()=>({status:'duplicate',operationId})}),sendPayment:async()=>{throw Error('inattendu');}};
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Preuve serveur/);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,1);
  mode='wrong';calls=0;await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Preuve serveur/);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,1);
  mode='ok';assert.deepEqual(await synchronizeDayInvoicePrototype(identity,identity,io),{sources:1,payments:0,remainingSources:0,remainingPayments:0});
 }finally{db.close();}
});


test('préétablie v6 après vente hors ligne : 600 + 250, règlement unique et reprise',async()=>{
 const {db,tx}=setup();try{
  const transaction=async<T>(fn:(t:typeof tx)=>Promise<T>)=>{db.exec('BEGIN');try{const value=await fn(tx);db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
  await transaction(t=>saveDayInvoiceReference(t,identity,identity,{...reference,journalStates:[],journalProofs:[]}));
  const draft=await captureNewDayInvoiceSale(tx,identity,clientId,day,[line],digest);await transaction(t=>confirmNewDayInvoiceSale(t,identity,{clientId,day,lines:[line],fingerprint:draft.fingerprint,saleId,operationId,createdAt:at},digest));
  const form=await captureNewDayPreinvoice(tx,identity,clientId,day,600000,digest);assert.equal(form.invoiceTotal,850000);assert.equal(form.balance,250000);
  const input={clientId,day,amount:600000,fingerprint:form.fingerprint,invoiceId,operationId:'44444444-4444-4444-8444-444444444444',createdAt:at};
  const failure={...tx,runAsync:async(sql:string,...args:(string|number|null)[])=>{if(sql.startsWith('INSERT INTO journal_sync_state'))throw Error('panne simulée');return tx.runAsync(sql,...args);}};
  db.exec('BEGIN');await assert.rejects(confirmNewDayPreinvoice(failure,identity,input,digest),/panne simulée/);db.exec('ROLLBACK');assert.equal(db.prepare('SELECT count(*) n FROM tour_pre_invoices').get()?.n,0);assert.equal(db.prepare('SELECT count(*) n FROM journal_sync_outbox').get()?.n,0);
  assert.equal((await transaction(t=>confirmNewDayPreinvoice(t,identity,input,digest))).status,'created');assert.equal((await transaction(t=>confirmNewDayPreinvoice(t,identity,input,digest))).status,'duplicate');
  await assert.rejects(confirmNewDayPreinvoice(tx,identity,{...input,amount:599000},digest),/différentes/);
  const invoice=await captureDayInvoiceForm(tx,identity,clientId,day,digest);assert.equal(invoice.view.total,850000);
  await transaction(t=>confirmDayInvoiceForm(t,identity,{clientId,day,fingerprint:invoice.fingerprint,operationId:paymentId,recordedAt:at,amount:200000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''},digest));
  assert.equal((await captureDayInvoiceForm(tx,identity,clientId,day,digest)).view.remaining,650000);assert.equal((await readDayInvoiceClients(tx,identity,digest)).clients[0].balance,650000);
  await assert.rejects(captureNewDayPreinvoice(tx,identity,clientId,day,1000,digest),/préétablie existe/);
 }finally{db.close();}
});

test('préétablie v6 : conflits, fermeture, date tunisienne et paiement antérieur bloquent',async()=>{
 const {db,tx}=setup();try{
  const blank={...reference,journalStates:[],journalProofs:[]};await saveDayInvoiceReference(tx,identity,identity,blank);
  await assert.rejects(captureNewDayPreinvoice(tx,{...identity,serverOrigin:'https://other.test'},clientId,day,600000,digest),/Identité/);
  await assert.rejects(captureNewDayPreinvoice(tx,identity,clientId,'2026-02-30',600000,digest),/invalide/);
  await assert.rejects(captureNewDayPreinvoice(tx,identity,clientId,day,0,digest),/invalide/);
  const pre=await captureNewDayPreinvoice(tx,identity,clientId,day,600000,digest),input={clientId,day,amount:600000,fingerprint:pre.fingerprint,invoiceId,operationId,createdAt:at};
  await assert.rejects(confirmNewDayPreinvoice(tx,identity,{...input,createdAt:'2026-01-01T23:30:00.000Z'},digest),/date/);
  await assert.rejects(confirmNewDayPreinvoice(tx,identity,{...input,fingerprint:'stale'},digest),/modifié/);
  db.prepare("INSERT INTO tour_known_server_states(commercial_id,journal_date,status,version) VALUES(?,?,'closed',1)").run(identity.commercialId,day);await assert.rejects(confirmNewDayPreinvoice(tx,identity,input,digest),/clôturée/);db.prepare('DELETE FROM tour_known_server_states').run();
  db.prepare("INSERT INTO identified_local_operations VALUES(?,?,'sale',?,?)").run(operationId,identity.commercialId,saleId,at);await assert.rejects(confirmNewDayPreinvoice(tx,identity,input,digest),/différentes|illisible/);db.prepare('DELETE FROM identified_local_operations').run();
  const draft=await captureNewDayInvoiceSale(tx,identity,clientId,day,[line],digest);await confirmNewDayInvoiceSale(tx,identity,{clientId,day,lines:[line],fingerprint:draft.fingerprint,saleId,operationId,createdAt:at},digest);
  const invoice=await captureDayInvoiceForm(tx,identity,clientId,day,digest);await confirmDayInvoiceForm(tx,identity,{clientId,day,fingerprint:invoice.fingerprint,operationId:paymentId,recordedAt:at,amount:100000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''},digest);
  await assert.rejects(captureNewDayPreinvoice(tx,identity,clientId,day,600000,digest),/déjà réglée/);assert.equal(db.prepare('SELECT count(*) n FROM tour_pre_invoices').get()?.n,0);
 }finally{db.close();}
});


test('préétablie durable : reprise, panne atomique, blocages et reçu vérifié',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-preinvoice-')),path=join(dir,'phone.db');let {db,tx}=setup(path);try{
  await saveDayInvoiceReference(tx,identity,identity,{...reference,journalStates:[],journalProofs:[]});const form=await captureNewDayPreinvoice(tx,identity,clientId,day,600000,digest),input={clientId,day,amount:600000,fingerprint:form.fingerprint,invoiceId,operationId,createdAt:at};
  await preparePreinvoiceAttempt(tx,identity,input,digest);await assert.rejects(assertDayInvoiceAttemptsSettled(tx,identity),/Préétablie en attente/);await assert.rejects(assertDayInvoiceAttemptsSettled(tx,identity,day),/Préétablie en attente/);await assertDayInvoiceAttemptsSettled(tx,identity,'2026-01-02');
  await assert.rejects(assertLegacyMobileDayInvoiceSafe(tx),/Tentative de facture du jour|Référence facture du jour/);await assert.rejects(acknowledgePreinvoiceAttempt(tx,identity,operationId),/non confirmée/);
  await assert.rejects(preparePreinvoiceAttempt(tx,identity,{...input,amount:700000},digest),/autre préétablie/);
  await cancelPreinvoiceAttempt(tx,identity,operationId);assert.equal(await readPreinvoiceAttempt(tx,identity),null);await preparePreinvoiceAttempt(tx,identity,input,digest);
  db.close();db=new DatabaseSync(path);tx=wrap(db);assert.deepEqual((await readPreinvoiceAttempt(tx,identity))?.attempt,input);
  const failure={...tx,runAsync:async(sql:string,...args:(string|number|null)[])=>{if(sql.startsWith('UPDATE day_invoice_preinvoice_attempt'))throw Error('panne avant reçu');return tx.runAsync(sql,...args);}};
  db.exec('BEGIN');await assert.rejects(confirmPreinvoiceAttempt(failure,identity,operationId,digest),/panne avant reçu/);db.exec('ROLLBACK');assert.equal(db.prepare('SELECT count(*) n FROM tour_pre_invoices').get()?.n,0);assert.equal(db.prepare('SELECT count(*) n FROM journal_sync_outbox').get()?.n,0);
  await assert.rejects(confirmNewDayPreinvoice(tx,identity,{...input,amount:700000},digest),/Préétablie en attente/);
  db.exec('BEGIN');assert.equal((await confirmPreinvoiceAttempt(tx,identity,operationId,digest)).status,'created');db.exec('COMMIT');await assertDayInvoiceAttemptsSettled(tx,identity);
  db.close();db=new DatabaseSync(path);tx=wrap(db);assert.equal((await confirmPreinvoiceAttempt(tx,identity,operationId,digest)).status,'duplicate');
  const original=db.prepare('SELECT payload FROM day_invoice_preinvoice_attempt').get()?.payload as string,corrupt=JSON.parse(original);corrupt.result.invoice.amount++;db.prepare('UPDATE day_invoice_preinvoice_attempt SET payload=?').run(JSON.stringify(corrupt));
  await assert.rejects(readPreinvoiceAttempt(tx,identity),/incohérente/);await assert.rejects(acknowledgePreinvoiceAttempt(tx,identity,operationId),/incohérente/);db.prepare('UPDATE day_invoice_preinvoice_attempt SET payload=?').run(original);
  await assert.rejects(cancelPreinvoiceAttempt(tx,identity,operationId),/abandonnable/);await assert.rejects(readPreinvoiceAttempt(tx,{...identity,serverOrigin:'https://wrong.test'}),/Identité/);
  await acknowledgePreinvoiceAttempt(tx,identity,operationId);assert.equal(await readPreinvoiceAttempt(tx,identity),null);assert.equal(db.prepare('SELECT count(*) n FROM tour_pre_invoices').get()?.n,1);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('orchestration préétablie : réponse locale perdue, relecture et même identifiant',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,{...reference,journalStates:[],journalProofs:[]});const form=await captureNewDayPreinvoice(tx,identity,clientId,day,600000,digest),input={clientId,day,amount:600000,fingerprint:form.fingerprint,invoiceId,operationId,createdAt:at};
  const transaction=async<T>(fn:(t:typeof tx)=>Promise<T>)=>{db.exec('BEGIN');try{const value=await fn(tx);db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
  let lose=true;const io={read:()=>transaction(t=>readPreinvoiceAttempt(t,identity)),prepare:(a:typeof input)=>transaction(t=>preparePreinvoiceAttempt(t,identity,a,digest)),confirm:async(id:string)=>{const result=await transaction(t=>confirmPreinvoiceAttempt(t,identity,id,digest));if(lose){lose=false;throw Error('réponse locale perdue');}return result;},acknowledge:(id:string)=>transaction(t=>acknowledgePreinvoiceAttempt(t,identity,id)),cancel:(id:string)=>transaction(t=>cancelPreinvoiceAttempt(t,identity,id))};
  await assert.rejects(startPreinvoiceAttempt(io,input),/réponse locale perdue/);assert.equal((await io.read())?.result?.status,'created');
  await assert.rejects(abandonPreinvoiceAttempt(io,input),/non abandonnable/);const resumed=await resumePreinvoiceAttempt(io,input);assert.equal(resumed.result?.invoice.id,invoiceId);await finishPreinvoiceAttempt(io,input);assert.equal(await io.read(),null);assert.equal(db.prepare('SELECT count(*) n FROM journal_sync_outbox').get()?.n,1);
 }finally{db.close();}
});
