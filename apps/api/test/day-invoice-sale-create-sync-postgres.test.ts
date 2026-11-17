import {dayInvoicePreinvoiceAttemptSchema,preparePreinvoiceAttempt,confirmPreinvoiceAttempt,acknowledgePreinvoiceAttempt} from '../../mobile/day-invoice-preinvoice-attempt.js';
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
  assert.equal((await transaction(t=>confirmDaySaleAttempt(t,identity,saleOperation,digest))).status,'duplicate');await transaction(t=>acknowledgeDaySaleAttempt(t,identity,saleOperation));
  const offline=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(offline.view.total,850000);
  const secondPayment=randomUUID(),secondInput={clientId,day,fingerprint:offline.fingerprint,operationId:secondPayment,recordedAt:'2026-01-01T10:01:00.000Z',amount:200000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:''};await transaction(t=>prepareDayPaymentAttempt(t,identity,secondInput,digest));await transaction(t=>confirmDayPaymentAttempt(t,identity,secondPayment,digest));
  assert.equal((await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest))).view.remaining,650000);
  assert.equal((await transaction(t=>readDayInvoiceClients(t,identity,digest))).clients.find(c=>c.id===clientId)?.balance,650000);
  await transaction(t=>acknowledgeDayPaymentAttempt(t,identity,secondPayment));
  const nextSaleId=randomUUID(),nextSaleOperation=randomUUID(),nextDraft=await transaction(t=>captureNewDayInvoiceSale(t,identity,clientId,day,sale.lines,digest));assert.equal(nextDraft.invoiceTotal,1100000);
  await transaction(t=>prepareDaySaleAttempt(t,identity,{clientId,day,lines:sale.lines,fingerprint:nextDraft.fingerprint,saleId:nextSaleId,operationId:nextSaleOperation,createdAt:'2026-01-01T10:02:00.000Z'},digest));
  await transaction(t=>confirmDaySaleAttempt(t,identity,nextSaleOperation,digest));await transaction(t=>acknowledgeDaySaleAttempt(t,identity,nextSaleOperation));
  const nextForm=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest)),lastPayment=randomUUID();assert.equal(nextForm.view.remaining,900000);
  await transaction(t=>confirmDayInvoiceForm(t,identity,{clientId,day,fingerprint:nextForm.fingerprint,operationId:lastPayment,recordedAt:'2026-01-01T10:03:00.000Z',amount:100000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''},digest));
  assert.equal((await transaction(t=>readDayInvoiceClients(t,identity,digest))).clients.find(c=>c.id===clientId)?.balance,800000);
  const nextPayload=JSON.parse(db.prepare('SELECT payload FROM sales_outbox WHERE operation_id=?').get(nextSaleOperation)?.payload as string);
  let lost=true,lostPayment=true,requests=0,paymentRequests=0;const trace:string[]=[];const post=(path:string,payload:string)=>fetch(`${base}/test/${path}`,{method:'POST',headers,body:payload});const lineage=(await pool.query('SELECT lineage_id FROM server_lineage_identity WHERE id=1')).rows[0].lineage_id;
  const io={transaction,digest,check:()=>{},verifyServer:async()=>{const r=await fetch(`${base}/test/server-lineage`,{headers});const v=await r.json() as {commercialId:string;lineageId:string};if(!r.ok||v.commercialId!==commercialId||v.lineageId!==lineage)throw Error('Lignée incohérente');},fetchReference,
   sendSource:async(path:string,payload:string)=>{requests++;trace.push(JSON.parse(payload).operationId);const r=await post(path==='settlements'?path:`day-invoice-sources/${path}`,payload);if(lost){lost=false;throw Error('Réponse perdue');}return r;},sendPayment:async(payload:string)=>{paymentRequests++;const payment=JSON.parse(payload);trace.push(payment.operationId);
    if(payment.operationId===lastPayment){
     const earlier={...payment,operationId:randomUUID(),recordedAt:'2026-01-01T10:01:30.000Z'};
     const rejectSale=await post('day-invoice-payments',JSON.stringify(earlier));assert.equal(rejectSale.status,409);assert.match(await rejectSale.text(),/antérieur à une vente/);
     const beforePayment={...payment,operationId:randomUUID(),recordedAt:'2026-01-01T10:00:30.000Z'};
     const rejectPayment=await post('day-invoice-payments',JSON.stringify(beforePayment));assert.equal(rejectPayment.status,409);assert.match(await rejectPayment.text(),/antérieur à un règlement/);
     const saved=(await pool.query('SELECT payload_hash FROM identified_sale_events WHERE operation_id=$1',[nextSaleOperation])).rows[0];
     await pool.query('UPDATE identified_sale_events SET payload_hash=$1 WHERE operation_id=$2',['0'.repeat(64),nextSaleOperation]);
     try{const rejectProof=await post('day-invoice-payments',payload);assert.equal(rejectProof.status,409);assert.match(await rejectProof.text(),/Preuve de vente incohérente/);}finally{await pool.query('UPDATE identified_sale_events SET payload_hash=$1 WHERE operation_id=$2',[saved.payload_hash,nextSaleOperation]);}
     assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_payments WHERE operation_id=ANY($1::uuid[])',[[earlier.operationId,beforePayment.operationId]])).rows[0].n,0);
    }
    const response=await post('day-invoice-payments',payload);if(lostPayment){lostPayment=false;throw Error('Réponse de paiement perdue');}return response;},sendOldDebt:async(payload:string)=>post('day-invoice-old-debt',payload)};
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Réponse perdue/);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,2);
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Réponse de paiement perdue/);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,1);assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payment_outbox').get()?.n,2);
  assert.deepEqual(await synchronizeDayInvoicePrototype(identity,identity,io),{sources:1,payments:2,remainingSources:0,remainingPayments:0});assert.equal(requests,3);assert.equal(paymentRequests,3);
  assert.deepEqual(trace,[saleOperation,saleOperation,secondPayment,secondPayment,nextSaleOperation,lastPayment]);
  const backdatedId=randomUUID(),backdatedAt='2026-01-01T10:00:00.000Z';
  const backdated={...nextPayload,operationId:randomUUID(),saleId:backdatedId,recordedAt:backdatedAt,sale:{...nextPayload.sale,syncSaleId:backdatedId,createdAt:backdatedAt}};
  const rejected=await post('day-invoice-sources/sales',JSON.stringify(backdated));assert.equal(rejected.status,409);assert.equal((await pool.query('SELECT count(*)::int n FROM identified_sale_events WHERE sale_id=$1',[backdatedId])).rows[0].n,0);
  assert.equal((await transaction(t=>confirmDayInvoiceForm(t,identity,secondInput,digest))).status,'duplicate');
  const form=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(form.view.total,1100000);assert.equal(form.view.remaining,800000);
  const clients=await transaction(t=>readDayInvoiceClients(t,identity,digest));assert.equal(clients.clients.find(c=>c.id===clientId)?.balance,800000);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_sale_events WHERE sale_id=$1',[saleId])).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_payments WHERE client_id=$1',[clientId])).rows[0].n,2);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_sale_events WHERE sale_id=$1',[nextSaleId])).rows[0].n,1);
  // Même montant et même version ne suffisent pas si le détail local change.
  const originalSale=db.prepare('SELECT payload FROM sales WHERE id=1').get()?.payload as string,alteredSale=JSON.parse(originalSale);alteredSale.lines[0].name='Produit altéré';
  db.prepare('UPDATE sales SET payload=? WHERE id=1').run(JSON.stringify(alteredSale));
  await assert.rejects(transaction(t=>captureDayInvoiceClose(t,identity,day,digest)),/Preuve de vente locale/);
  db.prepare('UPDATE sales SET payload=? WHERE id=1').run(originalSale);
  const proof=await transaction(t=>captureDayInvoiceClose(t,identity,day,digest));assert.equal(proof.sales.saleStates.find(s=>s.saleId===saleId)?.version,1);assert.equal(proof.sales.saleStates.find(s=>s.saleId===saleId)?.total,250000);
  const attempt=await transaction(t=>prepareDayInvoiceCloseAttempt(t,identity,day,0,randomUUID,digest));assert.equal(attempt.cashProof,proof.cashProof);
  const close=await post('day-invoice-close',JSON.stringify({requestId:attempt.requestId,day,expectedVersion:0,cashProof:attempt.cashProof}));assert.equal(close.status,201);
  const repeated=await post('day-invoice-close',JSON.stringify({requestId:attempt.requestId,day,expectedVersion:0,cashProof:attempt.cashProof}));assert.equal(repeated.status,200);

 }finally{phone?.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await pool?.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});

test('vente, paiement, préétablie et nouveau paiement hors ligne : reprise et clôture',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');const schema='sls_create_sync_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined,server:Server|undefined,phone:DatabaseSync|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);
  const clientId=randomUUID(),commercialId=randomUUID(),saleId=randomUUID(),day='2026-01-01',at='2026-01-01T09:00:00.000Z',saleOperation=randomUUID();
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[clientId,'Client fictif']);await pool.query("INSERT INTO articles(id,code,name,purchase_ttc,sale_ttc,vat_rate) VALUES($1,'X','Produit',200000,250000,1900)",[randomUUID()]);await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif suffisamment long pour les tests';await setCommercialCredentials(pool,'admin',commercialId,{login:'edit.sync',password:'mot de passe fictif'});const login=await loginCommercial(pool,secret,{login:'edit.sync',password:'mot de passe fictif'});assert.ok(login);const session={secret,token:login.token};
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:210084,discount:0,vat:1900}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  const invoiceId=randomUUID(),invoiceOperation=randomUUID();
  const app=express();app.use(express.json());app.use('/test',identifiedCommercialRoutes(pool,secret,{dayInvoiceTestOnly:true}));server=createServer(app);await new Promise<void>((resolve,reject)=>server!.listen(0,'127.0.0.1',()=>resolve()).once('error',reject));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`,identity={commercialId,serverOrigin:base};
  phone=new DatabaseSync(':memory:');const db=phone;db.exec(`PRAGMA foreign_keys=ON;${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}${saleEventTimeSchema}${dayInvoiceCloseAttemptSchema}${dayInvoiceSaleAttemptSchema}${dayInvoicePaymentAttemptSchema}${dayInvoicePreinvoiceAttemptSchema}
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
  assert.equal((await transaction(t=>confirmDaySaleAttempt(t,identity,saleOperation,digest))).status,'duplicate');await transaction(t=>acknowledgeDaySaleAttempt(t,identity,saleOperation));
  const initialForm=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest)),firstPayment=randomUUID();
  const firstInput={clientId,day,fingerprint:initialForm.fingerprint,operationId:firstPayment,recordedAt:'2026-01-01T09:01:00.000Z',amount:100000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:''};
  await transaction(t=>prepareDayPaymentAttempt(t,identity,firstInput,digest));await transaction(t=>confirmDayPaymentAttempt(t,identity,firstPayment,digest));await transaction(t=>acknowledgeDayPaymentAttempt(t,identity,firstPayment));
  const pre=await transaction(t=>captureNewDayPreinvoice(t,identity,clientId,day,600000,digest));assert.equal(pre.invoiceTotal,850000);
  const preInput={clientId,day,amount:600000,fingerprint:pre.fingerprint,invoiceId,operationId:invoiceOperation,createdAt:'2026-01-01T09:02:00.000Z'};
  await assert.rejects(transaction(t=>confirmNewDayPreinvoice(t,identity,{...preInput,createdAt:at},digest)),/antérieure à un paiement/);
  await transaction(t=>preparePreinvoiceAttempt(t,identity,preInput,digest));
  assert.equal((await transaction(t=>confirmPreinvoiceAttempt(t,identity,invoiceOperation,digest))).status,'created');
  assert.equal((await transaction(t=>confirmPreinvoiceAttempt(t,identity,invoiceOperation,digest))).status,'duplicate');await transaction(t=>acknowledgePreinvoiceAttempt(t,identity,invoiceOperation));
  assert.equal((await transaction(t=>readDayInvoiceClients(t,identity,digest))).clients.find(c=>c.id===clientId)?.balance,150000);
  const journalPayload=JSON.parse(db.prepare('SELECT payload FROM journal_sync_outbox WHERE operation_id=?').get(invoiceOperation)?.payload as string);
  const offline=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(offline.view.total,850000);
  const secondPayment=randomUUID(),secondInput={clientId,day,fingerprint:offline.fingerprint,operationId:secondPayment,recordedAt:'2026-01-01T10:01:00.000Z',amount:200000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:''};await transaction(t=>prepareDayPaymentAttempt(t,identity,secondInput,digest));await transaction(t=>confirmDayPaymentAttempt(t,identity,secondPayment,digest));
  assert.equal((await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest))).view.remaining,550000);
  assert.equal((await transaction(t=>readDayInvoiceClients(t,identity,digest))).clients.find(c=>c.id===clientId)?.balance,550000);
  let lost=true,lostPayment=true,requests=0,paymentRequests=0;const trace:string[]=[];const post=(path:string,payload:string)=>fetch(`${base}/test/${path}`,{method:'POST',headers,body:payload});const lineage=(await pool.query('SELECT lineage_id FROM server_lineage_identity WHERE id=1')).rows[0].lineage_id;
  const io={transaction,digest,check:()=>{},verifyServer:async()=>{const r=await fetch(`${base}/test/server-lineage`,{headers});const v=await r.json() as {commercialId:string;lineageId:string};if(!r.ok||v.commercialId!==commercialId||v.lineageId!==lineage)throw Error('Lignée incohérente');},fetchReference,
   sendSource:async(path:string,payload:string)=>{requests++;trace.push(JSON.parse(payload).operationId);const r=await post(path==='settlements'?path:`day-invoice-sources/${path}`,payload);if(lost){lost=false;throw Error('Réponse perdue');}return r;},sendPayment:async(payload:string)=>{paymentRequests++;const payment=JSON.parse(payload);trace.push(payment.operationId);
    if(payment.operationId===secondPayment){
     const earlier={...payment,operationId:randomUUID(),recordedAt:'2026-01-01T09:01:30.000Z'};
     const rejectPre=await post('day-invoice-payments',JSON.stringify(earlier));assert.equal(rejectPre.status,409);assert.match(await rejectPre.text(),/antérieur à la préétablie/);
     const row=(await pool.query('SELECT payload_hash FROM identified_journal_events WHERE operation_id=$1',[invoiceOperation])).rows[0];
     await pool.query('UPDATE identified_journal_events SET payload_hash=$1 WHERE operation_id=$2',['0'.repeat(64),invoiceOperation]);
     try{const rejectProof=await post('day-invoice-payments',payload);assert.equal(rejectProof.status,409);assert.match(await rejectProof.text(),/Preuve de préétablie incohérente/);}finally{await pool.query('UPDATE identified_journal_events SET payload_hash=$1 WHERE operation_id=$2',[row.payload_hash,invoiceOperation]);}
     assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_payments WHERE operation_id=$1',[earlier.operationId])).rows[0].n,0);
    }
    const response=await post('day-invoice-payments',payload);if(lostPayment){lostPayment=false;throw Error('Réponse de paiement perdue');}return response;},sendOldDebt:async(payload:string)=>post('day-invoice-old-debt',payload)};
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Réponse perdue/);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,1);
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Réponse de paiement perdue/);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,0);assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payment_outbox').get()?.n,2);
  assert.deepEqual(await synchronizeDayInvoicePrototype(identity,identity,io),{sources:1,payments:2,remainingSources:0,remainingPayments:0});assert.equal(requests,3);assert.equal(paymentRequests,3);
  assert.deepEqual(trace,[saleOperation,saleOperation,firstPayment,firstPayment,invoiceOperation,secondPayment]);
  const badId=randomUUID(),badOperation=randomUUID(),backdated={...journalPayload,operationId:badOperation,invoice:{...journalPayload.invoice,id:badId,createdAt:at}};
  const rejected=await post('day-invoice-sources/journal',JSON.stringify(backdated));assert.equal(rejected.status,409);assert.match(await rejected.text(),/Préétablie antérieure à un paiement/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_journal_events WHERE operation_id=$1',[badOperation])).rows[0].n,0);
  assert.equal((await transaction(t=>confirmDayPaymentAttempt(t,identity,secondPayment,digest))).status,'duplicate');await transaction(t=>acknowledgeDayPaymentAttempt(t,identity,secondPayment));
  assert.equal((await transaction(t=>confirmDayInvoiceForm(t,identity,secondInput,digest))).status,'duplicate');
  assert.equal((await transaction(t=>confirmNewDayPreinvoice(t,identity,preInput,digest))).status,'duplicate');
  const form=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(form.view.total,850000);assert.equal(form.view.remaining,550000);
  const clients=await transaction(t=>readDayInvoiceClients(t,identity,digest));assert.equal(clients.clients.find(c=>c.id===clientId)?.balance,550000);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_sale_events WHERE sale_id=$1',[saleId])).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_payments WHERE client_id=$1',[clientId])).rows[0].n,2);
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
