import {assertDayInvoiceAttemptsSettled} from '../../mobile/day-invoice-attempt-guard.js';
import {dayInvoiceSaleEditAttemptSchema,prepareSaleEditAttempt,confirmSaleEditAttempt,readSaleEditAttempt,acknowledgeSaleEditAttempt} from '../../mobile/day-invoice-sale-edit-attempt.js';
import {resumeSaleEditAttempt} from '../../mobile/day-invoice-sale-edit-attempt-flow.js';
/** Téléphone SQLite et serveur PostgreSQL fictifs : révision hors ligne, reprise HTTP. */
import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';import {createServer,type Server} from 'node:http';import express from 'express';import pg from 'pg';
import {schemaSql} from '../src/schema.js';import {dayInvoiceServerSchema,storeDayInvoicePayment} from '../src/day-invoice-store.js';import {identifiedCommercialRoutes} from '../src/identified-tour-routes.js';
import {setCommercialCredentials} from '../src/commercials.js';import {loginCommercial} from '../src/commercial-session.js';import {storeJournalSnapshot} from '../src/journal-store.js';import {storeIdentifiedSale} from '../src/identified-operations.js';import {readServerDayInvoiceSource} from '../src/day-invoice-source.js';
import {identifiedDeviceSchema} from '../../mobile/identified-device.js';import {tourCloseQueueSchema} from '../../mobile/tour-close-queue.js';import {creditReferencePrototypeSchema} from '../../mobile/credit-note-reference-cache-prototype.js';import {offlineCreditPrototypeSchema} from '../../mobile/credit-note-offline-prototype.js';import {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference} from '../../mobile/day-invoice-reference-cache.js';import {dayInvoiceQueueSchema} from '../../mobile/day-invoice-queue.js';import {saleEventTimeSchema} from '../../mobile/sale-event-time.js';
import {dayInvoiceCloseAttemptSchema,prepareDayInvoiceCloseAttempt} from '../../mobile/day-invoice-close-attempt.js';
import {captureDayInvoiceClose} from '../../mobile/day-invoice-close-capture.js';
import {captureDayInvoiceSaleEdit,confirmDayInvoiceSaleEdit} from '../../mobile/day-invoice-sale-edit.js';import {captureDayInvoiceForm,confirmDayInvoiceForm} from '../../mobile/day-invoice-form.js';import {readDayInvoiceClients} from '../../mobile/day-invoice-clients.js';import {synchronizeDayInvoicePrototype} from '../../mobile/day-invoice-sync.js';

test('révision locale v6 : HTTP, réponse perdue, reprise et solde sans doublon',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');const schema='sls_edit_sync_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined,server:Server|undefined,phone:DatabaseSync|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);
  const clientId=randomUUID(),commercialId=randomUUID(),saleId=randomUUID(),day='2026-01-01',at='2026-01-01T09:00:00.000Z',saleOperation=randomUUID();
  const otherClient=randomUUID(),otherSaleId=randomUUID(),otherSaleOperation=randomUUID();
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0),($3,$4,0)',[clientId,'Client fictif',otherClient,'Autre client']);await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif suffisamment long pour les tests';await setCommercialCredentials(pool,'admin',commercialId,{login:'edit.sync',password:'mot de passe fictif'});const login=await loginCommercial(pool,secret,{login:'edit.sync',password:'mot de passe fictif'});assert.ok(login);const session={secret,token:login.token};
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:210084,discount:0,vat:1900}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:saleOperation,saleId,version:1,recordedAt:at,sale,refund:0},{...session,enforceMode:true});
  const invoice={id:randomUUID(),journalDate:day,clientId,clientName:'Client fictif',sector:'',amount:600000,createdAt:at},invoiceOperation=randomUUID(),snapshot={operationId:invoiceOperation,version:1,invoice,receipts:[]};await storeJournalSnapshot(pool,snapshot,'identified',{...session,enforceMode:true});
  // Le premier paiement est conservé hors ligne jusqu'après la révision.
  // L'ordre d'envoi doit respecter les versions qu'il a photographiées.
  const app=express();app.use(express.json());app.use('/test',identifiedCommercialRoutes(pool,secret,{dayInvoiceTestOnly:true}));server=createServer(app);await new Promise<void>((resolve,reject)=>server!.listen(0,'127.0.0.1',()=>resolve()).once('error',reject));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`,identity={commercialId,serverOrigin:base};
  phone=new DatabaseSync(':memory:');const db=phone;db.exec(`PRAGMA foreign_keys=ON;${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}${saleEventTimeSchema}${dayInvoiceCloseAttemptSchema}${dayInvoiceSaleEditAttemptSchema}
   CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
   CREATE TABLE sale_revisions(id INTEGER PRIMARY KEY,sale_id INTEGER,created_at TEXT,previous_payload TEXT,new_payload TEXT,refund INTEGER);
   CREATE TABLE tour_expenses(pending INTEGER);CREATE TABLE tour_expense_revisions(pending INTEGER);CREATE TABLE tour_expense_cancellations(pending INTEGER);
   CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);`);
  db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(commercialId,base);db.prepare('INSERT INTO sales VALUES(1,?,?)').run(clientId,JSON.stringify(sale));db.prepare("INSERT INTO identified_local_operations VALUES(?,?,'sale',?,?)").run(saleOperation,commercialId,saleId,at);
  db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(invoice.id,clientId,day,JSON.stringify(invoice));db.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(invoice.id,1,JSON.stringify(snapshot));db.prepare("INSERT INTO identified_local_operations VALUES(?,?,'journal',?,?)").run(invoiceOperation,commercialId,invoice.id,at);

  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{db.prepare(sql).run(...args)}};
  const transaction=async<T>(work:(t:typeof tx)=>Promise<T>)=>{db.exec('BEGIN');try{const result=await work(tx);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
  const digest=async(text:string)=>createHash('sha256').update(text).digest('hex'),headers={Authorization:`Bearer ${login.token}`,'Content-Type':'application/json'};
  const fetchReference=async()=>{const response=await fetch(`${base}/test/day-invoice-reference`,{headers});assert.equal(response.status,200);return response.json();};const initial=await fetchReference();await transaction(t=>saveDayInvoiceReference(t,identity,identity,initial));
  const firstForm=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));
  const firstPaymentId=randomUUID();await transaction(t=>confirmDayInvoiceForm(t,identity,{clientId,day,fingerprint:firstForm.fingerprint,operationId:firstPaymentId,recordedAt:'2026-01-01T09:30:00.000Z',amount:200000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''},digest));
  const otherSale={...sale,clientId:otherClient,clientName:'Autre client',syncSaleId:otherSaleId},otherEvent={operationId:otherSaleOperation,saleId:otherSaleId,version:1,sale:otherSale,refund:0};
  db.prepare('INSERT INTO sales VALUES(2,?,?)').run(otherClient,JSON.stringify(otherSale));db.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(otherSaleOperation,otherSaleId,1,JSON.stringify(otherEvent));db.prepare("INSERT INTO identified_local_operations VALUES(?,?,'sale',?,?)").run(otherSaleOperation,commercialId,otherSaleId,at);
  const lines=[{...sale.lines[0],quantity:2}],draft=await transaction(t=>captureDayInvoiceSaleEdit(t,identity,1,lines,digest));assert.equal(draft.assessment.total,1100000);assert.equal(draft.assessment.remaining,900000);
  await assert.rejects(transaction(t=>confirmDayInvoiceSaleEdit(t,identity,{saleId:1,lines,fingerprint:draft.fingerprint,operationId:randomUUID(),recordedAt:'2026-01-01T09:15:00.000Z'},digest)),/antérieure à un paiement/);
  const editId=randomUUID(),editAttempt={saleId:1,clientId,day,lines,fingerprint:draft.fingerprint,operationId:editId,recordedAt:'2026-01-01T10:00:00.000Z'};
  await transaction(t=>prepareSaleEditAttempt(t,identity,editAttempt,digest));
  await assert.rejects(transaction(t=>assertDayInvoiceAttemptsSettled(t,identity)),/Modification en attente/);
  const editIO={read:()=>transaction(t=>readSaleEditAttempt(t,identity)),prepare:(input:typeof editAttempt)=>transaction(t=>prepareSaleEditAttempt(t,identity,input,digest)),confirm:(id:string)=>transaction(t=>confirmSaleEditAttempt(t,identity,id,digest)),acknowledge:(id:string)=>transaction(t=>acknowledgeSaleEditAttempt(t,identity,id)),cancel:async()=>{throw Error('Annulation non prévue');}};
  // La transaction locale a pu être validée alors que sa réponse est perdue.
  await editIO.confirm(editId);const receipt=await resumeSaleEditAttempt(editIO,editAttempt);assert.equal(receipt.result?.updated.syncVersion,2);
  assert.equal(db.prepare('SELECT count(*) n FROM sale_revisions').get()?.n,1);
  const offline=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(offline.view.remaining,900000);
  const secondPayment=randomUUID(),secondInput={clientId,day,fingerprint:offline.fingerprint,operationId:secondPayment,recordedAt:'2026-01-01T10:01:00.000Z',amount:100000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:''};await transaction(t=>confirmDayInvoiceForm(t,identity,secondInput,digest));
  assert.equal((await transaction(t=>confirmDayInvoiceForm(t,identity,secondInput,digest))).status,'duplicate');
  assert.equal((await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest))).view.remaining,800000);
  assert.equal((await transaction(t=>readDayInvoiceClients(t,identity,digest))).clients.find(c=>c.id===clientId)?.balance,800000);
  const previousRevision=db.prepare('SELECT previous_payload FROM sale_revisions WHERE sale_id=1').get()?.previous_payload as string,alteredPrevious=JSON.parse(previousRevision);alteredPrevious.lines[0].name='Ancienne ligne altérée';
  db.prepare('UPDATE sale_revisions SET previous_payload=? WHERE sale_id=1').run(JSON.stringify(alteredPrevious));
  assert.equal((await transaction(t=>readDayInvoiceClients(t,identity,digest))).clients.find(c=>c.id===clientId)?.conflict,true);
  db.prepare('UPDATE sale_revisions SET previous_payload=? WHERE sale_id=1').run(previousRevision);
  assert.equal((await transaction(t=>readDayInvoiceClients(t,identity,digest))).clients.find(c=>c.id===clientId)?.balance,800000);
  let lost=true,lostPayment=true,requests=0,paymentRequests=0;const trace:string[]=[];const post=(path:string,payload:string)=>fetch(`${base}/test/${path}`,{method:'POST',headers,body:payload});const lineage=(await pool.query('SELECT lineage_id FROM server_lineage_identity WHERE id=1')).rows[0].lineage_id;
  const io={transaction,digest,check:()=>{},verifyServer:async()=>{const r=await fetch(`${base}/test/server-lineage`,{headers});const v=await r.json() as {commercialId:string;lineageId:string};if(!r.ok||v.commercialId!==commercialId||v.lineageId!==lineage)throw Error('Lignée incohérente');},fetchReference,
   sendSource:async(path:string,payload:string)=>{requests++;trace.push(JSON.parse(payload).operationId);const r=await post(path==='settlements'?path:`day-invoice-sources/${path}`,payload);if(lost){lost=false;throw Error('Réponse perdue');}return r;},sendPayment:async(payload:string)=>{paymentRequests++;trace.push(JSON.parse(payload).operationId);const response=await post('day-invoice-payments',payload);if(lostPayment){lostPayment=false;throw Error('Réponse de paiement perdue');}return response;},sendOldDebt:async(payload:string)=>post('day-invoice-old-debt',payload)};
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Réponse perdue/);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,2);
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Réponse de paiement perdue/);
  assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payment_outbox').get()?.n,2);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_sale_events WHERE operation_id=$1',[editId])).rows[0].n,0);
  assert.deepEqual(await synchronizeDayInvoicePrototype(identity,identity,io),{sources:1,payments:2,remainingSources:0,remainingPayments:0});assert.equal(requests,3);assert.equal(paymentRequests,3);
  assert.deepEqual(trace,[otherSaleOperation,otherSaleOperation,firstPaymentId,firstPaymentId,editId,secondPayment]);
  const serverFirst=(await pool.query('SELECT payload FROM identified_day_invoice_payments WHERE operation_id=$1',[firstPaymentId])).rows[0].payload;
  assert.deepEqual(serverFirst.sales,[{id:saleId,version:1}]);
  assert.equal((await transaction(t=>confirmDayInvoiceForm(t,identity,secondInput,digest))).status,'duplicate');
  const form=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(form.view.total,1100000);assert.equal(form.view.remaining,800000);
  const clients=await transaction(t=>readDayInvoiceClients(t,identity,digest));assert.equal(clients.clients.find(c=>c.id===clientId)?.balance,800000);
  assert.equal((await transaction(t=>readSaleEditAttempt(t,identity)))?.result?.updated.syncVersion,2);await editIO.acknowledge(editId);assert.equal(await editIO.read(),null);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_sale_events WHERE sale_id=$1',[saleId])).rows[0].n,2);assert.equal(db.prepare('SELECT count(*) n FROM sale_revisions').get()?.n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_payments WHERE client_id=$1',[clientId])).rows[0].n,2);
  const proof=await transaction(t=>captureDayInvoiceClose(t,identity,day,digest));assert.equal(proof.sales.saleStates.find(s=>s.saleId===saleId)?.version,2);assert.equal(proof.sales.saleStates.find(s=>s.saleId===saleId)?.total,500000);
  const attempt=await transaction(t=>prepareDayInvoiceCloseAttempt(t,identity,day,0,randomUUID,digest));assert.equal(attempt.cashProof,proof.cashProof);
  const close=await post('day-invoice-close',JSON.stringify({requestId:attempt.requestId,day,expectedVersion:0,cashProof:attempt.cashProof}));assert.equal(close.status,201);
  const repeated=await post('day-invoice-close',JSON.stringify({requestId:attempt.requestId,day,expectedVersion:0,cashProof:attempt.cashProof}));assert.equal(repeated.status,200);

 }finally{phone?.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await pool?.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
