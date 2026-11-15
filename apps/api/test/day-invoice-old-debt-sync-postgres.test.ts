/** HTTP + SQLite + PostgreSQL fictifs : dette distincte, facture du jour et réponse perdue. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServer,type Server} from 'node:http';
import express from 'express';import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {dayInvoiceServerSchema} from '../src/day-invoice-store.js';
import {identifiedCommercialRoutes} from '../src/identified-tour-routes.js';
import {setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeJournalSnapshot} from '../src/journal-store.js';
import {storeIdentifiedSale} from '../src/identified-operations.js';
import {identifiedDeviceSchema} from '../../mobile/identified-device.js';
import {tourCloseQueueSchema} from '../../mobile/tour-close-queue.js';
import {creditReferencePrototypeSchema} from '../../mobile/credit-note-reference-cache-prototype.js';
import {offlineCreditPrototypeSchema} from '../../mobile/credit-note-offline-prototype.js';
import {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference} from '../../mobile/day-invoice-reference-cache.js';
import {dayInvoiceQueueSchema} from '../../mobile/day-invoice-queue.js';
import {captureOldDebtForm,confirmOldDebtForm} from '../../mobile/day-invoice-old-debt-form.js';
import {captureDayInvoiceForm,confirmDayInvoiceForm} from '../../mobile/day-invoice-form.js';
import {synchronizeDayInvoicePrototype} from '../../mobile/day-invoice-sync.js';
import {readDayInvoiceClients} from '../../mobile/day-invoice-clients.js';

test('dette et facture hors ligne : reprise HTTP après réponse perdue et absence de doublon',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');
 const schema='sls_debt_sync_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined,server:Server|undefined,phone:DatabaseSync|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);
  const clientId=randomUUID(),commercialId=randomUUID(),saleId=randomUUID(),day='2026-01-01',at='2026-01-01T09:00:00.000Z';
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[clientId,'Client fictif',100000]);await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif suffisamment long pour les tests';await setCommercialCredentials(pool,'admin',commercialId,{login:'debt.sync',password:'mot de passe fictif'});const login=await loginCommercial(pool,secret,{login:'debt.sync',password:'mot de passe fictif'});assert.ok(login);const session={secret,token:login.token};
  const invoice={id:randomUUID(),journalDate:day,clientId,clientName:'Client fictif',sector:'',amount:600000,createdAt:at};await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',{...session,enforceMode:true});
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:210084,discount:0,vat:1900}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},{...session,enforceMode:true});
  const app=express();app.use(express.json());app.use('/test',identifiedCommercialRoutes(pool,secret,{dayInvoiceTestOnly:true}));server=createServer(app);await new Promise<void>((resolve,reject)=>server!.listen(0,'127.0.0.1',()=>resolve()).once('error',reject));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`,identity={commercialId,serverOrigin:base};
  phone=new DatabaseSync(':memory:');const db=phone;db.exec(`PRAGMA foreign_keys=ON;${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}
   CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,created_at TEXT,client_id TEXT,payload TEXT);
   CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);`);
  db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(commercialId,base);
  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{db.prepare(sql).run(...args)}};
  const transaction=async<T>(work:(t:typeof tx)=>Promise<T>)=>{db.exec('BEGIN');try{const result=await work(tx);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
  const digest=async(text:string)=>createHash('sha256').update(text).digest('hex'),headers={Authorization:`Bearer ${login.token}`,'Content-Type':'application/json'};
  const fetchReference=async()=>{const response=await fetch(`${base}/test/day-invoice-reference`,{headers});if(!response.ok)throw Error(`reference ${response.status}`);return response.json();};
  const initial=await fetchReference();await transaction(t=>saveDayInvoiceReference(t,identity,identity,initial));
  const oldDebt=await transaction(t=>captureOldDebtForm(t,identity,clientId,day,digest));assert.equal(oldDebt.available,100000);
  const debtId=randomUUID(),debt={invoiceDay:day,event:{operationId:debtId,settlement:{syncOperationId:debtId,createdAt:at,clientId,clientName:'Client fictif',amount:60000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:''}}};
  assert.equal(await transaction(t=>confirmOldDebtForm(t,identity,{fingerprint:oldDebt.fingerprint,event:debt},digest)),'created');
  const invoiceForm=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(invoiceForm.view.total,850000);assert.equal(invoiceForm.view.remaining,850000);
  const payment=await transaction(t=>confirmDayInvoiceForm(t,identity,{clientId,day,fingerprint:invoiceForm.fingerprint,operationId:randomUUID(),recordedAt:at,amount:200000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''},digest));
  assert.equal(payment.status,'created');
  let lost=true,oldRequests=0,paymentRequests=0;const post=(path:string,payload:string)=>fetch(`${base}/test/${path}`,{method:'POST',headers,body:payload});
  const lineage=(await pool.query('SELECT lineage_id FROM server_lineage_identity WHERE id=1')).rows[0].lineage_id;
  const io={transaction,check:()=>{},verifyServer:async()=>{const r=await fetch(`${base}/test/server-lineage`,{headers});const v=await r.json() as {commercialId:string;lineageId:string};if(!r.ok||v.commercialId!==commercialId||v.lineageId!==lineage)throw Error('Lignée incohérente');},fetchReference,
   sendSource:async(path:string,payload:string)=>post(path==='settlements'?path:`day-invoice-sources/${path}`,payload),
   sendOldDebt:async(payload:string)=>{oldRequests++;const response=await post('day-invoice-old-debt',payload);if(lost){lost=false;throw Error('Réponse perdue');}return response;},
   sendPayment:async(payload:string)=>{paymentRequests++;return post('day-invoice-payments',payload);}};
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Réponse perdue/);assert.equal(oldRequests,1);assert.equal(paymentRequests,0);
  assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_old_debt_outbox').get()?.n,1);assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payment_outbox').get()?.n,1);
  const after=await synchronizeDayInvoicePrototype(identity,identity,io);assert.deepEqual(after,{sources:1,payments:1,remainingSources:0,remainingPayments:0});assert.equal(oldRequests,2);assert.equal(paymentRequests,1);
  const clients=await transaction(t=>readDayInvoiceClients(t,identity,digest));assert.equal(clients.clients.find(c=>c.id===clientId)?.balance,690000);
  const finalForm=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(finalForm.view.total,850000);assert.equal(finalForm.view.remaining,650000);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_old_debt')).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_payments')).rows[0].n,1);
 }finally{phone?.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await pool?.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
