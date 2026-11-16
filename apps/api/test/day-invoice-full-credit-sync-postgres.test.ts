/** HTTP + SQLite + PostgreSQL fictifs : crédit total, paiement ultérieur et réponse perdue. */
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

test('crédit total et règlement partiel : reprise hors ligne puis HTTP sans doublon',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');
 const schema='sls_credit_full_sync_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined,server:Server|undefined,phone:DatabaseSync|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);
  const clientId=randomUUID(),commercialId=randomUUID(),saleId=randomUUID(),day='2026-01-01',at='2026-01-01T09:00:00.000Z';
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[clientId,'Client fictif',100000]);await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif suffisamment long pour les tests';await setCommercialCredentials(pool,'admin',commercialId,{login:'credit.full.sync',password:'mot de passe fictif'});const login=await loginCommercial(pool,secret,{login:'credit.full.sync',password:'mot de passe fictif'});assert.ok(login);const session={secret,token:login.token};
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
  const invoiceForm=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(invoiceForm.view.total,850000);assert.equal(invoiceForm.view.remaining,850000);
  const creditId=randomUUID(),creditInput={clientId,day,fingerprint:invoiceForm.fingerprint,operationId:creditId,recordedAt:at,amount:0,mode:'Crédit' as const,chequeNumber:'',chequeBank:'',chequeDue:''};
  assert.equal((await transaction(t=>confirmDayInvoiceForm(t,identity,creditInput,digest))).status,'created');
  const declared=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(declared.view.remaining,850000);assert.equal(declared.view.paid,0);assert.equal(declared.view.declared,true);
  assert.equal((await transaction(t=>readDayInvoiceClients(t,identity,digest))).clients.find(c=>c.id===clientId)?.balance,950000);
  const payment=await transaction(t=>confirmDayInvoiceForm(t,identity,{clientId,day,fingerprint:declared.fingerprint,operationId:randomUUID(),recordedAt:'2026-01-01T09:01:00.000Z',amount:200000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''},digest));assert.equal(payment.status,'created');
  let lost=true,paymentRequests=0;const post=(path:string,payload:string)=>fetch(`${base}/test/${path}`,{method:'POST',headers,body:payload});
  const lineage=(await pool.query('SELECT lineage_id FROM server_lineage_identity WHERE id=1')).rows[0].lineage_id;
  const io={transaction,digest,check:()=>{},verifyServer:async()=>{const r=await fetch(`${base}/test/server-lineage`,{headers});const v=await r.json() as {commercialId:string;lineageId:string};if(!r.ok||v.commercialId!==commercialId||v.lineageId!==lineage)throw Error('Lignée incohérente');},fetchReference,
   sendSource:async(path:string,payload:string)=>post(path==='settlements'?path:`day-invoice-sources/${path}`,payload),
   sendOldDebt:async(payload:string)=>post('day-invoice-old-debt',payload),
   sendPayment:async(payload:string)=>{paymentRequests++;const response=await post('day-invoice-payments',payload);if(lost){lost=false;throw Error('Réponse perdue');}return response;}};
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Réponse perdue/);assert.equal(paymentRequests,1);
  const snapshotAfterCredit=await fetchReference() as {clients:{id:string;serverBalance:string}[];dayPayments:{operationId:string;mode:string;amount:number}[]};
  assert.equal(snapshotAfterCredit.clients.find(c=>c.id===clientId)?.serverBalance,'950000');assert.equal(snapshotAfterCredit.dayPayments.find(p=>p.operationId===creditId)?.amount,0);
  const report=await fetch(`${base}/test/day/${day}/details`,{headers});assert.equal(report.status,200);const creditJournal=await report.json() as {journalCollected:number;rows:{clientId:string;declared:boolean;totalClient:number}[]};
  assert.equal(creditJournal.journalCollected,0);assert.equal(creditJournal.rows.find(r=>r.clientId===clientId)?.declared,true);assert.equal(creditJournal.rows.find(r=>r.clientId===clientId)?.totalClient,850000);
  assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payment_outbox').get()?.n,2);
  const after=await synchronizeDayInvoicePrototype(identity,identity,io);assert.deepEqual(after,{sources:0,payments:2,remainingSources:0,remainingPayments:0});assert.equal(paymentRequests,3);
  const clients=await transaction(t=>readDayInvoiceClients(t,identity,digest));assert.equal(clients.clients.find(c=>c.id===clientId)?.balance,750000);
  const finalForm=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(finalForm.view.total,850000);assert.equal(finalForm.view.remaining,650000);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_payments')).rows[0].n,2);
  assert.equal((await transaction(t=>confirmDayInvoiceForm(t,identity,creditInput,digest))).status,'duplicate');
  // Deux téléphones ne peuvent pas déclarer à la fois crédit total et paiement
  // partiel sur la même version non traitée de la facture.
  const competingClient=randomUUID(),competingInvoice=randomUUID();await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[competingClient,'Client concurrence']);
  await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice:{...invoice,id:competingInvoice,clientId:competingClient,clientName:'Client concurrence'},receipts:[]},'identified',{...session,enforceMode:true});
  const creditEvent={...payment.payment,operationId:randomUUID(),clientId:competingClient,amount:0,mode:'Crédit',preInvoice:{id:competingInvoice,version:1,total:600000,declare:true},sales:[]};
  const partialEvent={...creditEvent,operationId:randomUUID(),amount:100000,mode:'Espèces'};
  const concurrent=await Promise.all([post('day-invoice-payments',JSON.stringify(creditEvent)),post('day-invoice-payments',JSON.stringify(partialEvent))]);
  assert.deepEqual(concurrent.map(r=>r.status).sort((a,b)=>a-b),[201,409]);assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_payments WHERE client_id=$1',[competingClient])).rows[0].n,1);
 }finally{phone?.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await pool?.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
