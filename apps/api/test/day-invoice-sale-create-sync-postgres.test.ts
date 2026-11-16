import {captureNewDayPreinvoice,confirmNewDayPreinvoice} from '../../mobile/day-invoice-preinvoice-create.js';
/** Téléphone SQLite et serveur PostgreSQL fictifs : création hors ligne, reprise HTTP. */
import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';import {createServer,type Server} from 'node:http';import express from 'express';import pg from 'pg';
import {schemaSql} from '../src/schema.js';import {dayInvoiceServerSchema} from '../src/day-invoice-store.js';import {identifiedCommercialRoutes} from '../src/identified-tour-routes.js';
import {setCommercialCredentials} from '../src/commercials.js';import {loginCommercial} from '../src/commercial-session.js';import {storeJournalSnapshot} from '../src/journal-store.js';
import {identifiedDeviceSchema} from '../../mobile/identified-device.js';import {tourCloseQueueSchema} from '../../mobile/tour-close-queue.js';import {creditReferencePrototypeSchema} from '../../mobile/credit-note-reference-cache-prototype.js';import {offlineCreditPrototypeSchema} from '../../mobile/credit-note-offline-prototype.js';import {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference} from '../../mobile/day-invoice-reference-cache.js';import {dayInvoiceQueueSchema} from '../../mobile/day-invoice-queue.js';import {saleEventTimeSchema} from '../../mobile/sale-event-time.js';
import {dayInvoiceCloseAttemptSchema,prepareDayInvoiceCloseAttempt} from '../../mobile/day-invoice-close-attempt.js';
import {captureDayInvoiceClose} from '../../mobile/day-invoice-close-capture.js';
import {dayInvoicePaymentAttemptSchema,prepareDayPaymentAttempt,confirmDayPaymentAttempt,acknowledgeDayPaymentAttempt} from '../../mobile/day-invoice-payment-attempt.js';
import {dayInvoiceSaleAttemptSchema,prepareDaySaleAttempt,confirmDaySaleAttempt,acknowledgeDaySaleAttempt} from '../../mobile/day-invoice-sale-attempt.js';
import {captureNewDayInvoiceSale} from '../../mobile/day-invoice-sale-create.js';import {captureDayInvoiceForm,confirmDayInvoiceForm} from '../../mobile/day-invoice-form.js';import {readDayInvoiceClients} from '../../mobile/day-invoice-clients.js';import {synchronizeDayInvoicePrototype} from '../../mobile/day-invoice-sync.js';

test('création vente v6 : SQLite, HTTP, réponse perdue, paiement unique et clôture',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');const schema='sls_create_sync_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined,server:Server|undefined,phone:DatabaseSync|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);
  const clientId=randomUUID(),commercialId=randomUUID(),saleId=randomUUID(),day='2026-01-01',at='2026-01-01T09:00:00.000Z',saleOperation=randomUUID();
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[clientId,'Client fictif']);await pool.query("INSERT INTO articles(id,code,name,purchase_ttc,sale_ttc,vat_rate) VALUES($1,'X','Produit',200000,250000,1900)",[randomUUID()]);await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif suffisamment long pour les tests';await setCommercialCredentials(pool,'admin',commercialId,{login:'edit.sync',password:'mot de passe fictif'});const login=await loginCommercial(pool,secret,{login:'edit.sync',password:'mot de passe fictif'});assert.ok(login);const session={secret,token:login.token};
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:210084,discount:0,vat:1900}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  const invoice={id:randomUUID(),journalDate:day,clientId,clientName:'Client fictif',sector:'',amount:600000,createdAt:at},invoiceOperation=randomUUID(),snapshot={operationId:invoiceOperation,version:1,invoice,receipts:[]};await storeJournalSnapshot(pool,snapshot,'identified',{...session,enforceMode:true});
  const app=express();app.use(express.json());app.use('/test',identifiedCommercialRoutes(pool,secret,{dayInvoiceTestOnly:true}));server=createServer(app);await new Promise<void>((resolve,reject)=>server!.listen(0,'127.0.0.1',()=>resolve()).once('error',reject));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`,identity={commercialId,serverOrigin:base};
  phone=new DatabaseSync(':memory:');const db=phone;db.exec(`PRAGMA foreign_keys=ON;${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}${saleEventTimeSchema}${dayInvoiceCloseAttemptSchema}${dayInvoiceSaleAttemptSchema}${dayInvoicePaymentAttemptSchema}
   CREATE TABLE sales(id INTEGER PRIMARY KEY,created_at TEXT,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
   CREATE TABLE sale_revisions(id INTEGER PRIMARY KEY,sale_id INTEGER,created_at TEXT,previous_payload TEXT,new_payload TEXT,refund INTEGER);
   CREATE TABLE tour_expenses(pending INTEGER);CREATE TABLE tour_expense_revisions(pending INTEGER);CREATE TABLE tour_expense_cancellations(pending INTEGER);
   CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);`);
  db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(commercialId,base);
  db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(invoice.id,clientId,day,JSON.stringify(invoice));db.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(invoice.id,1,JSON.stringify(snapshot));db.prepare("INSERT INTO identified_local_operations VALUES(?,?,'journal',?,?)").run(invoiceOperation,commercialId,invoice.id,at);

  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{db.prepare(sql).run(...args)}};
  const transaction=async<T>(work:(t:typeof tx)=>Promise<T>)=>{db.exec('BEGIN');try{const result=await work(tx);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
  const digest=async(text:string)=>createHash('sha256').update(text).digest('hex'),headers={Authorization:`Bearer ${login.token}`,'Content-Type':'application/json'};
  const fetchReference=async()=>{const response=await fetch(`${base}/test/day-invoice-reference`,{headers});assert.equal(response.status,200);return response.json();};const initial=await fetchReference();await transaction(t=>saveDayInvoiceReference(t,identity,identity,initial));
  const draft=await transaction(t=>captureNewDayInvoiceSale(t,identity,clientId,day,sale.lines,digest));assert.equal(draft.invoiceTotal,850000);
  await transaction(t=>prepareDaySaleAttempt(t,identity,{clientId,day,lines:sale.lines,fingerprint:draft.fingerprint,saleId,operationId:saleOperation,createdAt:at},digest));
  assert.equal((await transaction(t=>confirmDaySaleAttempt(t,identity,saleOperation,digest))).status,'saved');
  const offline=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(offline.view.total,850000);
  const secondPayment=randomUUID(),secondInput={clientId,day,fingerprint:offline.fingerprint,operationId:secondPayment,recordedAt:'2026-01-01T10:01:00.000Z',amount:200000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:''};await transaction(t=>prepareDayPaymentAttempt(t,identity,secondInput,digest));await transaction(t=>confirmDayPaymentAttempt(t,identity,secondPayment,digest));
  assert.equal((await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest))).view.remaining,650000);
  assert.equal((await transaction(t=>readDayInvoiceClients(t,identity,digest))).clients.find(c=>c.id===clientId)?.balance,650000);
  let lost=true,lostPayment=true,requests=0,paymentRequests=0;const post=(path:string,payload:string)=>fetch(`${base}/test/${path}`,{method:'POST',headers,body:payload});const lineage=(await pool.query('SELECT lineage_id FROM server_lineage_identity WHERE id=1')).rows[0].lineage_id;
  const io={transaction,digest,check:()=>{},verifyServer:async()=>{const r=await fetch(`${base}/test/server-lineage`,{headers});const v=await r.json() as {commercialId:string;lineageId:string};if(!r.ok||v.commercialId!==commercialId||v.lineageId!==lineage)throw Error('Lignée incohérente');},fetchReference,
   sendSource:async(path:string,payload:string)=>{requests++;const r=await post(path==='settlements'?path:`day-invoice-sources/${path}`,payload);if(lost){lost=false;throw Error('Réponse perdue');}return r;},sendPayment:async(payload:string)=>{paymentRequests++;const response=await post('day-invoice-payments',payload);if(lostPayment){lostPayment=false;throw Error('Réponse de paiement perdue');}return response;},sendOldDebt:async(payload:string)=>post('day-invoice-old-debt',payload)};
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Réponse perdue/);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,1);
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Réponse de paiement perdue/);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,0);assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payment_outbox').get()?.n,1);
  assert.deepEqual(await synchronizeDayInvoicePrototype(identity,identity,io),{sources:0,payments:1,remainingSources:0,remainingPayments:0});assert.equal(requests,2);assert.equal(paymentRequests,2);
  assert.equal((await transaction(t=>confirmDaySaleAttempt(t,identity,saleOperation,digest))).status,'duplicate');
  await transaction(t=>acknowledgeDaySaleAttempt(t,identity,saleOperation));
  assert.equal((await transaction(t=>confirmDayPaymentAttempt(t,identity,secondPayment,digest))).status,'duplicate');await transaction(t=>acknowledgeDayPaymentAttempt(t,identity,secondPayment));
  assert.equal((await transaction(t=>confirmDayInvoiceForm(t,identity,secondInput,digest))).status,'duplicate');
  const form=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(form.view.total,850000);assert.equal(form.view.remaining,650000);
  const clients=await transaction(t=>readDayInvoiceClients(t,identity,digest));assert.equal(clients.clients.find(c=>c.id===clientId)?.balance,650000);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_sale_events WHERE sale_id=$1',[saleId])).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_payments WHERE client_id=$1',[clientId])).rows[0].n,1);
  // Même montant et même version ne suffisent pas si le détail local change.
  const originalSale=db.prepare('SELECT payload FROM sales').get()?.payload as string,alteredSale=JSON.parse(originalSale);alteredSale.lines[0].name='Produit altéré';
  db.prepare('UPDATE sales SET payload=?').run(JSON.stringify(alteredSale));
  await assert.rejects(transaction(t=>captureDayInvoiceClose(t,identity,day,digest)),/Preuve de vente locale/);
  db.prepare('UPDATE sales SET payload=?').run(originalSale);
  const proof=await transaction(t=>captureDayInvoiceClose(t,identity,day,digest));assert.equal(proof.sales.saleStates.find(s=>s.saleId===saleId)?.version,1);assert.equal(proof.sales.saleStates.find(s=>s.saleId===saleId)?.total,250000);
  const attempt=await transaction(t=>prepareDayInvoiceCloseAttempt(t,identity,day,0,randomUUID,digest));assert.equal(attempt.cashProof,proof.cashProof);
  const close=await post('day-invoice-close',JSON.stringify({requestId:attempt.requestId,day,expectedVersion:0,cashProof:attempt.cashProof}));assert.equal(close.status,201);
  const repeated=await post('day-invoice-close',JSON.stringify({requestId:attempt.requestId,day,expectedVersion:0,cashProof:attempt.cashProof}));assert.equal(repeated.status,200);

 }finally{phone?.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await pool?.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});

test('préétablie et vente créées hors ligne : synchronisation, paiement unique et clôture',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');const schema='sls_create_sync_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined,server:Server|undefined,phone:DatabaseSync|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);
  const clientId=randomUUID(),commercialId=randomUUID(),saleId=randomUUID(),day='2026-01-01',at='2026-01-01T09:00:00.000Z',saleOperation=randomUUID();
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[clientId,'Client fictif']);await pool.query("INSERT INTO articles(id,code,name,purchase_ttc,sale_ttc,vat_rate) VALUES($1,'X','Produit',200000,250000,1900)",[randomUUID()]);await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif suffisamment long pour les tests';await setCommercialCredentials(pool,'admin',commercialId,{login:'edit.sync',password:'mot de passe fictif'});const login=await loginCommercial(pool,secret,{login:'edit.sync',password:'mot de passe fictif'});assert.ok(login);const session={secret,token:login.token};
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:210084,discount:0,vat:1900}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  const invoiceId=randomUUID(),invoiceOperation=randomUUID();
  const app=express();app.use(express.json());app.use('/test',identifiedCommercialRoutes(pool,secret,{dayInvoiceTestOnly:true}));server=createServer(app);await new Promise<void>((resolve,reject)=>server!.listen(0,'127.0.0.1',()=>resolve()).once('error',reject));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`,identity={commercialId,serverOrigin:base};
  phone=new DatabaseSync(':memory:');const db=phone;db.exec(`PRAGMA foreign_keys=ON;${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}${saleEventTimeSchema}${dayInvoiceCloseAttemptSchema}${dayInvoiceSaleAttemptSchema}${dayInvoicePaymentAttemptSchema}
   CREATE TABLE sales(id INTEGER PRIMARY KEY,created_at TEXT,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
   CREATE TABLE sale_revisions(id INTEGER PRIMARY KEY,sale_id INTEGER,created_at TEXT,previous_payload TEXT,new_payload TEXT,refund INTEGER);
   CREATE TABLE tour_expenses(pending INTEGER);CREATE TABLE tour_expense_revisions(pending INTEGER);CREATE TABLE tour_expense_cancellations(pending INTEGER);
   CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,version INTEGER,payload TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT PRIMARY KEY,version INTEGER,payload TEXT);`);
  db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(commercialId,base);

  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{db.prepare(sql).run(...args)}};
  const transaction=async<T>(work:(t:typeof tx)=>Promise<T>)=>{db.exec('BEGIN');try{const result=await work(tx);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
  const digest=async(text:string)=>createHash('sha256').update(text).digest('hex'),headers={Authorization:`Bearer ${login.token}`,'Content-Type':'application/json'};
  const fetchReference=async()=>{const response=await fetch(`${base}/test/day-invoice-reference`,{headers});assert.equal(response.status,200);return response.json();};const initial=await fetchReference();await transaction(t=>saveDayInvoiceReference(t,identity,identity,initial));
  const draft=await transaction(t=>captureNewDayInvoiceSale(t,identity,clientId,day,sale.lines,digest));assert.equal(draft.invoiceTotal,250000);
  await transaction(t=>prepareDaySaleAttempt(t,identity,{clientId,day,lines:sale.lines,fingerprint:draft.fingerprint,saleId,operationId:saleOperation,createdAt:at},digest));
  assert.equal((await transaction(t=>confirmDaySaleAttempt(t,identity,saleOperation,digest))).status,'saved');
  const pre=await transaction(t=>captureNewDayPreinvoice(t,identity,clientId,day,600000,digest));assert.equal(pre.invoiceTotal,850000);
  const preInput={clientId,day,amount:600000,fingerprint:pre.fingerprint,invoiceId,operationId:invoiceOperation,createdAt:at};
  assert.equal((await transaction(t=>confirmNewDayPreinvoice(t,identity,preInput,digest))).status,'created');
  const offline=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(offline.view.total,850000);
  const secondPayment=randomUUID(),secondInput={clientId,day,fingerprint:offline.fingerprint,operationId:secondPayment,recordedAt:'2026-01-01T10:01:00.000Z',amount:200000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:''};await transaction(t=>prepareDayPaymentAttempt(t,identity,secondInput,digest));await transaction(t=>confirmDayPaymentAttempt(t,identity,secondPayment,digest));
  assert.equal((await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest))).view.remaining,650000);
  assert.equal((await transaction(t=>readDayInvoiceClients(t,identity,digest))).clients.find(c=>c.id===clientId)?.balance,650000);
  let lost=true,lostPayment=true,requests=0,paymentRequests=0;const post=(path:string,payload:string)=>fetch(`${base}/test/${path}`,{method:'POST',headers,body:payload});const lineage=(await pool.query('SELECT lineage_id FROM server_lineage_identity WHERE id=1')).rows[0].lineage_id;
  const io={transaction,digest,check:()=>{},verifyServer:async()=>{const r=await fetch(`${base}/test/server-lineage`,{headers});const v=await r.json() as {commercialId:string;lineageId:string};if(!r.ok||v.commercialId!==commercialId||v.lineageId!==lineage)throw Error('Lignée incohérente');},fetchReference,
   sendSource:async(path:string,payload:string)=>{requests++;const r=await post(path==='settlements'?path:`day-invoice-sources/${path}`,payload);if(lost){lost=false;throw Error('Réponse perdue');}return r;},sendPayment:async(payload:string)=>{paymentRequests++;const response=await post('day-invoice-payments',payload);if(lostPayment){lostPayment=false;throw Error('Réponse de paiement perdue');}return response;},sendOldDebt:async(payload:string)=>post('day-invoice-old-debt',payload)};
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Réponse perdue/);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,1);
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Réponse de paiement perdue/);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,0);assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payment_outbox').get()?.n,1);
  assert.deepEqual(await synchronizeDayInvoicePrototype(identity,identity,io),{sources:0,payments:1,remainingSources:0,remainingPayments:0});assert.equal(requests,3);assert.equal(paymentRequests,2);
  assert.equal((await transaction(t=>confirmDaySaleAttempt(t,identity,saleOperation,digest))).status,'duplicate');
  await transaction(t=>acknowledgeDaySaleAttempt(t,identity,saleOperation));
  assert.equal((await transaction(t=>confirmDayPaymentAttempt(t,identity,secondPayment,digest))).status,'duplicate');await transaction(t=>acknowledgeDayPaymentAttempt(t,identity,secondPayment));
  assert.equal((await transaction(t=>confirmDayInvoiceForm(t,identity,secondInput,digest))).status,'duplicate');
  assert.equal((await transaction(t=>confirmNewDayPreinvoice(t,identity,preInput,digest))).status,'duplicate');
  const form=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(form.view.total,850000);assert.equal(form.view.remaining,650000);
  const clients=await transaction(t=>readDayInvoiceClients(t,identity,digest));assert.equal(clients.clients.find(c=>c.id===clientId)?.balance,650000);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_sale_events WHERE sale_id=$1',[saleId])).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_payments WHERE client_id=$1',[clientId])).rows[0].n,1);
  // Même montant et même version ne suffisent pas si le détail local change.
  const originalSale=db.prepare('SELECT payload FROM sales').get()?.payload as string,alteredSale=JSON.parse(originalSale);alteredSale.lines[0].name='Produit altéré';
  db.prepare('UPDATE sales SET payload=?').run(JSON.stringify(alteredSale));
  await assert.rejects(transaction(t=>captureDayInvoiceClose(t,identity,day,digest)),/Preuve de vente locale/);
  db.prepare('UPDATE sales SET payload=?').run(originalSale);
  const proof=await transaction(t=>captureDayInvoiceClose(t,identity,day,digest));assert.equal(proof.sales.saleStates.find(s=>s.saleId===saleId)?.version,1);assert.equal(proof.sales.saleStates.find(s=>s.saleId===saleId)?.total,250000);
  const attempt=await transaction(t=>prepareDayInvoiceCloseAttempt(t,identity,day,0,randomUUID,digest));assert.equal(attempt.cashProof,proof.cashProof);
  const close=await post('day-invoice-close',JSON.stringify({requestId:attempt.requestId,day,expectedVersion:0,cashProof:attempt.cashProof}));assert.equal(close.status,201);
  const repeated=await post('day-invoice-close',JSON.stringify({requestId:attempt.requestId,day,expectedVersion:0,cashProof:attempt.cashProof}));assert.equal(repeated.status,200);

 }finally{phone?.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await pool?.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
