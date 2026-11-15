/** Essai HTTP/SQLite/PostgreSQL isolé. Cette route de test n'est pas installée sur l'API réelle. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServer,type Server} from 'node:http';
import express from 'express';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {dayInvoiceServerSchema} from '../src/day-invoice-store.js';
import {identifiedCommercialRoutes} from '../src/identified-tour-routes.js';
import {setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeJournalSnapshot} from '../src/journal-store.js';
import {changeTourClosure} from '../src/tour-closure-store.js';
import {storeIdentifiedSale,storeIdentifiedSettlement} from '../src/identified-operations.js';
import {acknowledgeDayInvoicePayment,dayInvoiceQueueSchema,type DayInvoiceQueueEntry} from '../../mobile/day-invoice-queue.js';
import {writeReconciledDayInvoicePayment,readLocalDayInvoiceSource} from '../../mobile/day-invoice-local.js';
import {buildMergedDayInvoiceView} from '../../mobile/day-invoice-merged-view.js';
import {guardDayInvoiceWrite} from '../../mobile/day-invoice-guards.js';
import {identifiedDeviceSchema} from '../../mobile/identified-device.js';
import {tourCloseQueueSchema,acknowledgeTourClose} from '../../mobile/tour-close-queue.js';
import {dayInvoiceCloseAttemptSchema,prepareDayInvoiceCloseAttempt,abandonDayInvoiceCloseAttempt,applyDayInvoiceReopenedState} from '../../mobile/day-invoice-close-attempt.js';
import {creditReferencePrototypeSchema} from '../../mobile/credit-note-reference-cache-prototype.js';
import {offlineCreditPrototypeSchema} from '../../mobile/credit-note-offline-prototype.js';
import {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference,readDayInvoiceReferenceCache} from '../../mobile/day-invoice-reference-cache.js';
import {uploadDayInvoicePayments} from '../../mobile/day-invoice-upload.js';
import {synchronizeDayInvoicePrototype} from '../../mobile/day-invoice-sync.js';
import {captureDayInvoiceExportPayments} from '../../mobile/day-invoice-journal-export.js';
import {captureDayInvoiceForm,confirmDayInvoiceForm} from '../../mobile/day-invoice-form.js';
import {readDayInvoiceClients} from '../../mobile/day-invoice-clients.js';
import {journalHtml,journalCsv} from '../../mobile/journal-export.js';
import {validateDayInvoiceReference,reconcileDayInvoiceClient} from '../../mobile/day-invoice-reference.js';
import type {DayInvoicePayment} from '../../../packages/domain/src/day-invoice.js';
import {dayInvoiceCashClosureCanonical} from '../../../packages/domain/src/day-invoice-cash.js';
import {readLocalDayInvoiceCash} from '../../mobile/day-invoice-cash.js';
import {captureDayInvoiceClose} from '../../mobile/day-invoice-close-capture.js';

test('HTTP réel en schéma isolé : réponse perdue, renvoi et accusé exact sans doublon',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');
 const schema='sls_day_http_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined,server:Server|undefined,created=false,phone:DatabaseSync|undefined;
 try {
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);
  const clientId=randomUUID(),commercialId=randomUUID(),invoiceId=randomUUID(),saleId=randomUUID(),day='2026-01-01',at='2026-01-01T09:00:00.000Z';
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[clientId,'Client fictif',0]);await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif suffisamment long pour les tests';await setCommercialCredentials(pool,'admin',commercialId,{login:'day.http',password:'mot de passe fictif'});const login=await loginCommercial(pool,secret,{login:'day.http',password:'mot de passe fictif'});assert.ok(login);
  const session={secret,token:login.token},invoice={id:invoiceId,journalDate:day,clientId,clientName:'Client fictif',sector:'',amount:600000,createdAt:at};
  const otherClient=randomUUID(),otherSettlement=randomUUID();
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[otherClient,'Autre client fictif',1000]);
  await storeIdentifiedSettlement(pool,{operationId:otherSettlement,settlement:{syncOperationId:otherSettlement,createdAt:'2026-01-01T23:30:00.000Z',clientId:otherClient,clientName:'Autre client fictif',amount:1000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}},{...session,enforceMode:true});
  const invoiceOperation=randomUUID(),saleOperation=randomUUID();
  await storeJournalSnapshot(pool,{operationId:invoiceOperation,version:1,invoice,receipts:[]},'identified',{...session,enforceMode:true});
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:210084,discount:0,vat:1900}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:saleOperation,saleId,version:1,recordedAt:at,sale,refund:0},{...session,enforceMode:true});
  const app=express();app.use(express.json());app.use('/default',identifiedCommercialRoutes(pool,secret));app.use('/test',identifiedCommercialRoutes(pool,secret,{dayInvoiceTestOnly:true}));
  server=createServer(app);await new Promise<void>((resolve,reject)=>server!.listen(0,'127.0.0.1',()=>resolve()).once('error',reject));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const identity={commercialId,serverOrigin:base},event:DayInvoicePayment={operationId:randomUUID(),clientId,day,recordedAt:'2026-01-01T12:00:00.000Z',amount:200000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]};
  const disabled=await fetch(`${base}/default/day-invoice-payments`,{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},body:JSON.stringify(event)});assert.equal(disabled.status,404);
  const unauthorized=await fetch(`${base}/test/day-invoice-payments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event)});assert.equal(unauthorized.status,401);
  const sourceEvent={operationId:saleOperation,saleId,version:1,recordedAt:at,sale,refund:0};
  const disabledSource=await fetch(`${base}/default/day-invoice-sources/sales`,{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},body:JSON.stringify(sourceEvent)});assert.equal(disabledSource.status,404);
  const unauthorizedSource=await fetch(`${base}/test/day-invoice-sources/sales`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sourceEvent)});assert.equal(unauthorizedSource.status,401);
  phone=new DatabaseSync(':memory:');phone.exec(`PRAGMA foreign_keys=ON;
   ${dayInvoiceQueueSchema}${identifiedDeviceSchema}${tourCloseQueueSchema}${dayInvoiceCloseAttemptSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}
   CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
   CREATE TABLE sale_revisions(id INTEGER PRIMARY KEY,sale_id INTEGER,created_at TEXT,previous_payload TEXT,new_payload TEXT,refund INTEGER);
   CREATE TABLE tour_expenses(pending INTEGER);CREATE TABLE tour_expense_revisions(pending INTEGER);CREATE TABLE tour_expense_cancellations(pending INTEGER);

   CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
   CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT,sale_id TEXT,payload TEXT);
   CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT,invoice_id TEXT,payload TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);
   CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);
   CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);`);const db=phone;
  db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(commercialId,base);
  db.prepare('INSERT INTO sales(id,client_id,payload) VALUES(1,?,?)').run(clientId,JSON.stringify(sale));
  db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(invoiceId,clientId,day,JSON.stringify(invoice));
  db.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(invoiceId,1,JSON.stringify({operationId:invoiceOperation,version:1,invoice,receipts:[]}));
  const addMarker=db.prepare('INSERT INTO identified_local_operations(operation_id,commercial_id,operation_kind,entity_id,recorded_at) VALUES(?,?,?,?,?)');
  addMarker.run(saleOperation,commercialId,'sale',saleId,at);addMarker.run(invoiceOperation,commercialId,'journal',invoiceId,at);
  const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};
  const getReference=async()=>{const r=await fetch(`${base}/test/day-invoice-reference`,{headers:{Authorization:`Bearer ${session.token}`}});assert.equal(r.status,200);return r.json();};
  const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');
  const initialLegacy=await fetch(`${base}/test/reference`,{headers:{Authorization:`Bearer ${session.token}`}});assert.equal(initialLegacy.status,200);
  const prior=await getReference();
  db.exec('BEGIN');await saveDayInvoiceReference(tx,identity,identity,prior);db.exec('COMMIT');
  db.exec('BEGIN');await writeReconciledDayInvoicePayment(tx,identity,event,(locked,id,payment)=>guardDayInvoiceWrite(locked,id,payment,digest));db.exec('COMMIT');
  const state=async()=>{const reference=await readDayInvoiceReferenceCache(tx,identity);assert.ok(reference);return reconcileDayInvoiceClient({reference,clientId,localSales:[{...sale,id:1}],localSettlements:[],localInvoices:[{...invoice,version:1,receipts:[]}],localDayPayments:[event]});};
  assert.deepEqual(await state(),{balance:650000,pendingAmount:200000});
  const localClients=await readDayInvoiceClients(tx,identity,digest);assert.equal(localClients.clients.find(c=>c.id===clientId)?.balance,650000);assert.equal(localClients.clients.find(c=>c.id===clientId)?.pendingDayPayments,200000);assert.equal(localClients.pendingOperations,1);
  let merged=buildMergedDayInvoiceView((await readDayInvoiceReferenceCache(tx,identity))!,await readLocalDayInvoiceSource(tx,identity,clientId,day),[event]);assert.equal(merged.remaining,650000);assert.equal(merged.payments[0].pending,true);
  const entries=()=>db.prepare('SELECT sequence,operation_id AS operationId,payload,commercial_id AS commercialId,server_origin AS serverOrigin FROM day_invoice_payment_outbox ORDER BY sequence').all() as DayInvoiceQueueEntry[];
  let lose=true;const send=async(payload:string)=>{const response=await fetch(`${base}/test/day-invoice-payments`,{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},body:payload});if(lose){lose=false;assert.equal(response.status,201);throw Error('réponse perdue');}return response;};
  const acknowledge=async(entry:DayInvoiceQueueEntry)=>{db.exec('BEGIN');try{await acknowledgeDayInvoicePayment(tx,entry);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}};
  await assert.rejects(uploadDayInvoicePayments(entries(),identity,identity,send,acknowledge),/perdue/);assert.equal(entries().length,1);
  // La référence peut arriver avant l'accusé perdu : le paiement ne doit pas
  // être soustrait une seconde fois, même si la file est encore présente.
  const afterReceipt=await getReference();db.exec('BEGIN');await saveDayInvoiceReference(tx,identity,identity,afterReceipt);db.exec('COMMIT');
  assert.deepEqual(await state(),{balance:650000,pendingAmount:0});assert.equal(entries().length,1);
  const obsoleteReference=await fetch(`${base}/test/reference`,{headers:{Authorization:`Bearer ${session.token}`}});assert.equal(obsoleteReference.status,409);
  await assert.rejects(captureDayInvoiceClose(tx,identity,day,digest),/en attente/);
  merged=buildMergedDayInvoiceView((await readDayInvoiceReferenceCache(tx,identity))!,await readLocalDayInvoiceSource(tx,identity,clientId,day),[event]);assert.equal(merged.remaining,650000);assert.equal(merged.payments[0].pending,false);
  const dates=(await readDayInvoiceReferenceCache(tx,identity))!;assert.deepEqual(dates.settlementDays,[{operationId:otherSettlement,clientId:otherClient,day:'2026-01-02'}]);assert.deepEqual(dates.saleDays,[{saleId,clientId,day}]);
  await assert.rejects(saveDayInvoiceReference(tx,identity,identity,prior),/Paiement serveur périmé/);
  // Les accusés des sources ont également été perdus : le contrôleur v6
  // reprend d'abord les sources puis le paiement, sans envoyer deux fois.
  db.prepare('INSERT INTO sales_outbox(operation_id,sale_id,payload) VALUES(?,?,?)').run(saleOperation,saleId,JSON.stringify({operationId:saleOperation,saleId,version:1,sale,refund:0}));
  db.prepare('INSERT INTO journal_sync_outbox(operation_id,invoice_id,payload) VALUES(?,?,?)').run(invoiceOperation,invoiceId,JSON.stringify({operationId:invoiceOperation,version:1,invoice,receipts:[]}));
  const lineage=(await pool.query('SELECT lineage_id FROM server_lineage_identity WHERE id=1')).rows[0].lineage_id as string;
  let sourceRequests=0,paymentRequests=0,enabled=true;
  const check=()=>{if(!enabled)throw Error('Session expirée');};
  const txWork=async<T>(work:(t:typeof tx)=>Promise<T>):Promise<T>=>{db.exec('BEGIN');try{const value=await work(tx);db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
  const syncIo={transaction:txWork,check,verifyServer:async(id:typeof identity,guard:()=>void)=>{guard();const r=await fetch(`${base}/test/server-lineage`,{headers:{Authorization:`Bearer ${session.token}`}});const v=await r.json() as {commercialId:string;lineageId:string};guard();if(!r.ok||v.commercialId!==id.commercialId||v.lineageId!==lineage||id.serverOrigin!==base)throw Error('Lignée incohérente');},
   fetchReference:getReference,sendSource:async(path:string,payload:string)=>{sourceRequests++;return fetch(`${base}/test/${path==='settlements'?path:`day-invoice-sources/${path}`}`,{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},body:payload});},
   sendPayment:async(payload:string)=>{paymentRequests++;return fetch(`${base}/test/day-invoice-payments`,{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},body:payload});}};
  const pendingExport=await txWork(t=>captureDayInvoiceExportPayments(t,identity,day));assert.equal(pendingExport.length,1);assert.equal(pendingExport[0].pending,true);
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,{...syncIo,verifyServer:async()=>{throw Error('Lignée incohérente');}}),/Lignée/);assert.equal(sourceRequests,0);assert.equal(paymentRequests,0);assert.equal(entries().length,1);
  db.prepare('UPDATE day_invoice_payments SET client_id=? WHERE operation_id=?').run(randomUUID(),event.operationId);
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,syncIo),/incohérent/);assert.equal(sourceRequests,0);assert.equal(paymentRequests,0);
  db.prepare('UPDATE day_invoice_payments SET client_id=? WHERE operation_id=?').run(clientId,event.operationId);
  const synced=await synchronizeDayInvoicePrototype(identity,identity,syncIo);assert.deepEqual(synced,{sources:2,payments:1,remainingSources:0,remainingPayments:0});assert.equal(sourceRequests,2);assert.equal(paymentRequests,1);assert.equal(entries().length,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sales_outbox').get()?.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM journal_sync_outbox').get()?.n,0);
  const syncedClients=await txWork(t=>readDayInvoiceClients(t,identity,digest));assert.equal(syncedClients.clients.find(c=>c.id===clientId)?.balance,650000);assert.equal(syncedClients.clients.find(c=>c.id===clientId)?.pendingDayPayments,0);assert.equal(syncedClients.pendingOperations,0);
  const localDebt={syncOperationId:otherSettlement,createdAt:'2026-01-01T23:30:00.000Z',clientId:otherClient,clientName:'Autre client fictif',amount:1000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  db.prepare('INSERT INTO settlements(id,client_id,payload) VALUES(1,?,?)').run(otherClient,JSON.stringify(localDebt));
  assert.equal((await readDayInvoiceClients(tx,identity,digest)).clients.find(c=>c.id===otherClient)?.balance,0);
  db.prepare('UPDATE settlements SET payload=?').run(JSON.stringify({...localDebt,amount:2000}));await assert.rejects(readDayInvoiceClients(tx,identity,digest),/Preuve de règlement/);db.exec('DELETE FROM settlements');
  const exportPayments=await txWork(t=>captureDayInvoiceExportPayments(t,identity,day));
  assert.equal(exportPayments.length,1);assert.equal(exportPayments[0].pending,false);
  const exportData={day,commercial:'Commercial fictif',rows:[{clientId,clientName:'Client fictif',sector:exportPayments[0].sector,preInvoice:invoice,sales:[{...sale,id:1}],total:850000}],receipts:[],settlements:[],dayInvoicePayments:exportPayments};
  const html=journalHtml(exportData),csv=journalCsv(exportData);assert.match(html,/850,000/);assert.match(html,/200,000 · Espèces 200,000/);assert.match(csv,/Règlement facture du jour/);assert.match(csv,/synchronisé/);

  const remote=await fetch(`${base}/test/day-invoice-reference`,{headers:{Authorization:`Bearer ${session.token}`}});assert.equal(remote.status,200);
  const snapshot=await remote.json() as {version:number;clients:{id:string;serverBalance:string}[];dayPayments:DayInvoicePayment[];journalStates:{id:string;declaredByDayPayment:boolean}[]};
  assert.equal(snapshot.version,6);assert.equal(snapshot.clients.find(c=>c.id===clientId)?.serverBalance,'650000');
  assert.equal(snapshot.dayPayments[0].operationId,event.operationId);assert.equal(snapshot.journalStates.find(j=>j.id===invoiceId)?.declaredByDayPayment,true);
  const parsed=validateDayInvoiceReference(snapshot);const calculated=reconcileDayInvoiceClient({reference:parsed,clientId,localSales:[{...sale,id:1}],localSettlements:[],localInvoices:[{...invoice,version:1,receipts:[]}],localDayPayments:[event]});
  assert.deepEqual(calculated,{balance:650000,pendingAmount:0});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_day_invoice_payments')).rows[0].n,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payments').get()?.n,1);
  // La preuve locale inclut la préétablie, la vente et le règlement unifié
  // complet. Une ancienne clôture reste refusée et le serveur recalcule tout.
  const localCash=await readLocalDayInvoiceCash(tx,identity,day);
  const salesCash={version:5,commercialId,day,initialEvents:[{operationId:saleOperation,saleId,clientId,recordedAt:at,paid:0}],refundEvents:[],saleStates:[{saleId,clientId,version:1,total:250000,paid:0}]};
  const journalCash={version:5,commercialId,day,events:[{kind:'invoice',operationId:invoiceOperation,invoiceId,clientId,recordedAt:at,amount:600000}]};
  const calculatedProof=await digest(dayInvoiceCashClosureCanonical(salesCash,journalCash,localCash,commercialId,day,[event]));
  const capture=await captureDayInvoiceClose(tx,identity,day,digest);const cashProof=capture.cashProof;
  assert.equal(cashProof,calculatedProof);
  db.exec("INSERT INTO sale_revisions(id,sale_id,created_at,previous_payload,new_payload,refund) VALUES(1,1,'2026-01-01T10:00:00.000Z','{}','{}',0)");await assert.rejects(captureDayInvoiceClose(tx,identity,day,digest),/incomplet|incohérent/);db.exec('DELETE FROM sale_revisions');
  db.exec('BEGIN');let attempt=await prepareDayInvoiceCloseAttempt(tx,identity,day,0,randomUUID,digest);db.exec('COMMIT');
  assert.equal(attempt.cashProof,cashProof);
  db.exec('BEGIN');assert.deepEqual(await prepareDayInvoiceCloseAttempt(tx,identity,day,0,randomUUID,digest),attempt);db.exec('COMMIT');
  db.exec('INSERT INTO tour_expenses(pending) VALUES(1)');await assert.rejects(prepareDayInvoiceCloseAttempt(tx,identity,day,0,randomUUID,digest),/en attente/);db.exec('DELETE FROM tour_expenses');
  assert.equal(db.prepare('SELECT count(*) AS n FROM tour_close_attempts').get()?.n,1);
  let body={requestId:attempt.requestId,day,expectedVersion:0,cashProof};
  const post=async(path:string,data:unknown,authorization=true)=>fetch(`${base}${path}`,{method:'POST',headers:{...(authorization?{Authorization:`Bearer ${session.token}`}:{ }),'Content-Type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await post('/default/day-invoice-close',body)).status,404);
  assert.equal((await post('/default/day-invoice-close/abandon',{requestId:randomUUID(),day,expectedVersion:0})).status,404);
  const abandoned={requestId:attempt.requestId,day,expectedVersion:0};const reservation=await post('/test/day-invoice-close/abandon',abandoned);assert.equal(reservation.status,200);
  const reservationBody=await reservation.json();db.exec('BEGIN');await abandonDayInvoiceCloseAttempt(tx,identity,day,attempt,reservationBody);db.exec('COMMIT');
  assert.equal(db.prepare('SELECT count(*) AS n FROM tour_close_attempts').get()?.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_close_attempt_markers').get()?.n,0);
  assert.equal((await post('/test/day-invoice-close',{...abandoned,cashProof})).status,409);
  db.exec('BEGIN');attempt=await prepareDayInvoiceCloseAttempt(tx,identity,day,0,randomUUID,digest);db.exec('COMMIT');body={requestId:attempt.requestId,day,expectedVersion:0,cashProof};
  assert.equal((await post('/test/day-invoice-close',body,false)).status,401);
  assert.equal((await post('/test/close',{requestId:randomUUID(),day,expectedVersion:0})).status,409);
  const wrong=await post('/test/day-invoice-close',{...body,cashProof:'0'.repeat(64)});assert.equal(wrong.status,409);
  assert.equal((await pool.query('SELECT status FROM tour_closures WHERE commercial_id=$1 AND journal_date=$2',[commercialId,day])).rows[0].status,'open');
  const close=await post('/test/day-invoice-close',body);assert.equal(close.status,201);
  // Simule une réponse perdue : le même UUID et la même preuve reprennent sans double clôture.
  db.exec('BEGIN');assert.deepEqual(await prepareDayInvoiceCloseAttempt(tx,identity,day,0,randomUUID,digest),attempt);db.exec('COMMIT');
  const retry=await post('/test/day-invoice-close',body);assert.equal(retry.status,200);const receipt=await retry.json() as {status:string};assert.equal(receipt.status,'duplicate');
  db.exec('BEGIN');await acknowledgeTourClose(tx,commercialId,day,receipt);db.exec('COMMIT');
  assert.equal(db.prepare('SELECT status FROM tour_close_attempts').get()?.status,'closed');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tour_closure_events WHERE commercial_id=$1 AND journal_date=$2',[commercialId,day])).rows[0].n,1);
  const afterClose={...event,operationId:randomUUID(),amount:1000,preInvoice:{...event.preInvoice!,declare:false}};
  assert.equal((await post('/test/day-invoice-payments',afterClose)).status,409);
  const reopened=await changeTourClosure(pool,commercialId,day,'reopen',{id:'admin',role:'admin'},1);db.exec('BEGIN');assert.equal(await applyDayInvoiceReopenedState(tx,identity,day,reopened),true);db.exec('COMMIT');
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_close_attempt_markers').get()?.n,0);

  // Deuxième journée : vente payée puis diminuée, remboursement et facture
  // préétablie. Le paiement initial et la sortie sont prouvés séparément.
  const day2='2026-01-03',at2='2026-01-03T09:00:00.000Z',editedAt='2026-01-03T10:00:00.000Z';
  const c2=randomUUID(),i2=randomUUID(),s2=randomUUID(),journal2=randomUUID(),sale2op=randomUUID(),edit2op=randomUUID();
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[c2,'Client modifié']);
  const pre2={...invoice,id:i2,clientId:c2,clientName:'Client modifié',journalDate:day2,createdAt:at2};
  const first2={...sale,syncSaleId:s2,clientId:c2,clientName:'Client modifié',createdAt:at2,paid:200000,remaining:50000,paymentMode:'Espèces'};
  const last2={...first2,syncVersion:2,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:119000,remaining:0};
  await storeJournalSnapshot(pool,{operationId:journal2,version:1,invoice:pre2,receipts:[]},'identified',{...session,enforceMode:true});
  await storeIdentifiedSale(pool,{operationId:sale2op,saleId:s2,version:1,recordedAt:at2,sale:first2,refund:0},{...session,enforceMode:true});
  await storeIdentifiedSale(pool,{operationId:edit2op,saleId:s2,version:2,recordedAt:editedAt,sale:last2,refund:81000},{...session,enforceMode:true});
  db.prepare('INSERT INTO sales(id,client_id,payload) VALUES(2,?,?)').run(c2,JSON.stringify(last2));
  db.prepare('INSERT INTO sale_revisions(id,sale_id,created_at,previous_payload,new_payload,refund) VALUES(2,2,?,?,?,81000)').run(editedAt,JSON.stringify({...first2,id:2}),JSON.stringify({...last2,id:2}));
  db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(i2,c2,day2,JSON.stringify(pre2));
  db.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(i2,1,JSON.stringify({operationId:journal2,version:1,invoice:pre2,receipts:[]}));
  addMarker.run(journal2,commercialId,'journal',i2,at2);addMarker.run(sale2op,commercialId,'sale',s2,at2);addMarker.run(edit2op,commercialId,'sale',s2,editedAt);
  db.exec('BEGIN');await saveDayInvoiceReference(tx,identity,identity,await getReference());db.exec('COMMIT');
  const pay2:DayInvoicePayment={operationId:randomUUID(),clientId:c2,day:day2,recordedAt:'2026-01-03T11:00:00.000Z',amount:100000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:i2,version:1,total:600000,declare:true},sales:[{id:s2,version:2}]};
  db.exec('BEGIN');await writeReconciledDayInvoicePayment(tx,identity,pay2,(locked,id,payment)=>guardDayInvoiceWrite(locked,id,payment,digest));db.exec('COMMIT');
  // Expiration après réception serveur mais avant l'accusé local : le même
  // événement reste en file et la reconnexion reprend sans doublon.
  const expiredIo={...syncIo,sendPayment:async(payload:string)=>{const response=await syncIo.sendPayment(payload);enabled=false;return response;}};
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,expiredIo),/Session expirée/);
  assert.equal(entries().length,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_day_invoice_payments WHERE operation_id=$1',[pay2.operationId])).rows[0].n,1);
  enabled=true;assert.deepEqual(await synchronizeDayInvoicePrototype(identity,identity,syncIo),{sources:0,payments:1,remainingSources:0,remainingPayments:0});
  const capture2=await captureDayInvoiceClose(tx,identity,day2,digest);
  assert.equal(capture2.sales.initialEvents[0].paid,200000);assert.equal(capture2.sales.refundEvents[0].refund,81000);assert.equal(capture2.sales.saleStates[0].total,119000);assert.equal(capture2.ownerDeclarations.length,1);
  const close2={requestId:randomUUID(),day:day2,expectedVersion:0,cashProof:capture2.cashProof};
  assert.equal((await post('/test/day-invoice-close',close2)).status,201);

  // La déclaration d'une préétablie de A, encaissée par B le lendemain,
  // figure dans la preuve propriétaire de A sans entrer dans sa caisse.
  const c3=randomUUID(),i3=randomUUID(),journal3=randomUUID(),otherCommercial=randomUUID(),day3='2026-01-04',at3='2026-01-04T09:00:00.000Z';
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[c3,'Client autre caisse']);
  await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[otherCommercial,'Autre commercial']);
  await setCommercialCredentials(pool,'admin',otherCommercial,{login:'day.http.other',password:'mot de passe fictif'});
  const loginB=await loginCommercial(pool,secret,{login:'day.http.other',password:'mot de passe fictif'});assert.ok(loginB);
  const pre3={...invoice,id:i3,clientId:c3,clientName:'Client autre caisse',journalDate:day3,createdAt:at3};
  await storeJournalSnapshot(pool,{operationId:journal3,version:1,invoice:pre3,receipts:[]},'identified',{...session,enforceMode:true});
  db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(i3,c3,day3,JSON.stringify(pre3));
  db.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(i3,1,JSON.stringify({operationId:journal3,version:1,invoice:pre3,receipts:[]}));addMarker.run(journal3,commercialId,'journal',i3,at3);
  const phoneB=new DatabaseSync(':memory:');let pay3:DayInvoicePayment;
  try{
   phoneB.exec(`${dayInvoiceQueueSchema}${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}
    CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
    CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);
    CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);`);
   const identityB={commercialId:otherCommercial,serverOrigin:base};phoneB.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(otherCommercial,base);
   const btx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>phoneB.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>phoneB.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{phoneB.prepare(sql).run(...p)}};
   const refResponse=await fetch(`${base}/test/day-invoice-reference`,{headers:{Authorization:`Bearer ${loginB.token}`}});assert.equal(refResponse.status,200);
   phoneB.exec('BEGIN');await saveDayInvoiceReference(btx,identityB,identityB,await refResponse.json());phoneB.exec('COMMIT');
   const form=await captureDayInvoiceForm(btx,identityB,c3,day3);assert.equal(form.remoteOnlyPreInvoice,true);assert.equal(form.view.total,600000);
   phoneB.exec('BEGIN');const created=await confirmDayInvoiceForm(btx,identityB,{clientId:c3,day:day3,fingerprint:form.fingerprint,operationId:randomUUID(),recordedAt:'2026-01-05T09:00:00.000Z',amount:120000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''},digest);phoneB.exec('COMMIT');pay3=created.payment;
   const balanceB=await readDayInvoiceClients(btx,identityB,digest);assert.equal(balanceB.clients.find(c=>c.id===c3)?.balance,480000);assert.equal(balanceB.clients.find(c=>c.id===c3)?.pendingDayPayments,120000);
   const bResponse=await fetch(`${base}/test/day-invoice-payments`,{method:'POST',headers:{Authorization:`Bearer ${loginB.token}`,'Content-Type':'application/json'},body:JSON.stringify(pay3)});assert.equal(bResponse.status,201);
   assert.equal(phoneB.prepare('SELECT count(*) AS n FROM tour_pre_invoices').get()?.n,0);
  }finally{phoneB.close();}
  db.exec('BEGIN');await saveDayInvoiceReference(tx,identity,identity,await getReference());db.exec('COMMIT');
  const capture3=await captureDayInvoiceClose(tx,identity,day3,digest);assert.deepEqual(capture3.dayPayments,[]);assert.deepEqual(capture3.ownerDeclarations,[pay3]);
  const close3={requestId:randomUUID(),day:day3,expectedVersion:0,cashProof:capture3.cashProof};assert.equal((await post('/test/day-invoice-close',close3)).status,201);
  const own=await fetch(`${base}/test/day/${day3}/details`,{headers:{Authorization:`Bearer ${session.token}`}});assert.equal(own.status,200);const ownReport=await own.json() as {journalCollected:number;rows:{declared:boolean}[]};assert.equal(ownReport.journalCollected,0);assert.equal(ownReport.rows[0].declared,true);
  const others=await fetch(`${base}/test/day/2026-01-05/details`,{headers:{Authorization:`Bearer ${loginB.token}`}});assert.equal(others.status,200);assert.equal((await others.json() as {journalCollected:number}).journalCollected,120000);

 }finally{if(phone)phone.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
