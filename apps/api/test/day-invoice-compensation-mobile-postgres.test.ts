/** SQLite et PostgreSQL fictifs : choix hors ligne puis reprise HTTP prouvée. */
import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';import {createServer,type Server} from 'node:http';import express from 'express';import pg from 'pg';
import {schemaSql} from '../src/schema.js';import {dayInvoiceServerSchema} from '../src/day-invoice-store.js';import {identifiedCommercialRoutes} from '../src/identified-tour-routes.js';
import {readCompensatedDayInvoiceSnapshot} from '../src/day-invoice-reference.js';
import {setCommercialCredentials} from '../src/commercials.js';import {loginCommercial} from '../src/commercial-session.js';import {storeJournalSnapshot} from '../src/journal-store.js';import {storeIdentifiedSale} from '../src/identified-operations.js';
import {dayInvoicePaymentAttemptSchema,readDayPaymentAttempt,prepareDayPaymentAttempt,confirmDayPaymentAttempt,acknowledgeDayPaymentAttempt,cancelDayPaymentAttempt} from '../../mobile/day-invoice-payment-attempt.js';
import {startPaymentAttempt,resumePaymentAttempt,finishPaymentAttempt} from '../../mobile/day-invoice-payment-attempt-flow.js';
import {captureDayInvoiceForm} from '../../mobile/day-invoice-form.js';import {makeDayPaymentAttempt} from '../../mobile/day-invoice-payment-input.js';import {synchronizeDayInvoicePrototype} from '../../mobile/day-invoice-sync.js';
import {identifiedDeviceSchema} from '../../mobile/identified-device.js';import {tourCloseQueueSchema} from '../../mobile/tour-close-queue.js';import {creditReferencePrototypeSchema} from '../../mobile/credit-note-reference-cache-prototype.js';import {offlineCreditPrototypeSchema} from '../../mobile/credit-note-offline-prototype.js';import {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference} from '../../mobile/day-invoice-reference-cache.js';import {dayInvoiceQueueSchema} from '../../mobile/day-invoice-queue.js';import {saleEventTimeSchema} from '../../mobile/sale-event-time.js';
import {createDayInvoiceTransportPrototype} from '../../mobile/day-invoice-transport.js';import {captureWorkspaceState} from '../../mobile/day-invoice-workspace-state.js';
import {captureDayInvoiceSaleEdit} from '../../mobile/day-invoice-sale-edit.js';import {dayInvoiceCompensationLocalSchema,confirmLocalCompensation,readLocalCompensation} from '../../mobile/day-invoice-compensation-local.js';import {readLocalCompensationView,readLocalCompensationCollectionImpact} from '../../mobile/day-invoice-compensation-view.js';import {synchronizeLocalCompensation} from '../../mobile/day-invoice-compensation-sync.js';import {reconcileCompensatedInvoice} from '../../mobile/day-invoice-compensation-reconcile.js';import {assertDayInvoiceAttemptsSettled} from '../../mobile/day-invoice-attempt-guard.js';

for(const choice of ['refund','credit'] as const)test(`compensation mobile ${choice} : SQLite, réponse HTTP perdue et reçu serveur`,async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');const schema='sls_comp_phone_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined,server:Server|undefined,phone:DatabaseSync|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);
  const clientId=randomUUID(),commercialId=randomUUID(),saleId=randomUUID(),day='2026-01-01',at='2026-01-01T09:00:00.000Z',saleOperation=randomUUID();
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[clientId,'Client fictif']);await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif suffisamment long pour les tests';await setCommercialCredentials(pool,'admin',commercialId,{login:'comp.phone',password:'mot de passe fictif'});const login=await loginCommercial(pool,secret,{login:'comp.phone',password:'mot de passe fictif'});assert.ok(login);const session={secret,token:login.token};
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:5,unitPrice:50000,discount:0,vat:0}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:saleOperation,saleId,version:1,recordedAt:at,sale,refund:0},{...session,enforceMode:true});
  const invoice={id:randomUUID(),journalDate:day,clientId,clientName:'Client fictif',sector:'',amount:600000,createdAt:at},invoiceOperation=randomUUID(),snapshot={operationId:invoiceOperation,version:1,invoice,receipts:[]};await storeJournalSnapshot(pool,snapshot,'identified',{...session,enforceMode:true});
  const app=express();app.use(express.json());app.use('/test',identifiedCommercialRoutes(pool,secret,{dayInvoiceTestOnly:true}));server=createServer(app);await new Promise<void>((resolve,reject)=>server!.listen(0,'127.0.0.1',()=>resolve()).once('error',reject));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`,identity={commercialId,serverOrigin:'https://sls-test.invalid'};
  phone=new DatabaseSync(':memory:');const db=phone;db.exec(`PRAGMA foreign_keys=ON;${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}${saleEventTimeSchema}${dayInvoiceCompensationLocalSchema}${dayInvoicePaymentAttemptSchema}
   CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
   CREATE TABLE sale_revisions(id INTEGER PRIMARY KEY,sale_id INTEGER,created_at TEXT,previous_payload TEXT,new_payload TEXT,refund INTEGER);
   CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);`);
  db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(commercialId,identity.serverOrigin);db.prepare('INSERT INTO sales VALUES(1,?,?)').run(clientId,JSON.stringify(sale));db.prepare("INSERT INTO identified_local_operations VALUES(?,?,'sale',?,?)").run(saleOperation,commercialId,saleId,at);
  db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(invoice.id,clientId,day,JSON.stringify(invoice));db.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(invoice.id,1,JSON.stringify(snapshot));db.prepare("INSERT INTO identified_local_operations VALUES(?,?,'journal',?,?)").run(invoiceOperation,commercialId,invoice.id,at);
  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{db.prepare(sql).run(...args)}};
  const transaction=async<T>(work:(t:typeof tx)=>Promise<T>)=>{db.exec('BEGIN');try{const result=await work(tx);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
  const digest=async(text:string)=>createHash('sha256').update(text).digest('hex'),headers={Authorization:`Bearer ${login.token}`,'Content-Type':'application/json'};
  const ref=await fetch(`${base}/test/day-invoice-reference`,{headers});assert.equal(ref.status,200);await transaction(async t=>saveDayInvoiceReference(t,identity,identity,await ref.json()));
  let lost=true,sends=0,lostPayment=true,paymentSends=0;const lineage=(await pool.query('SELECT lineage_id FROM server_lineage_identity WHERE id=1')).rows[0].lineage_id;
  // Le transport complet utilise une origine HTTPS fictive ; seul l'adaptateur
  // de test redirige les requêtes vers le serveur local isolé.
  const mobileSession={id:commercialId,name:login.commercial.name,serverOrigin:identity.serverOrigin,token:login.token,expiresAt:login.expiresAt};
  const transport=createDayInvoiceTransportPrototype(mobileSession,identity,{...identity,lineageId:lineage},{isCurrentSession:()=>true,request:async(url,options)=>{
   assert.ok(url.startsWith(`${identity.serverOrigin}/api/mobile/identified/`));const path=url.slice(`${identity.serverOrigin}/api/mobile/identified/`.length);
   const response=await fetch(`${base}/test/${path}`,options);if(path==='day-invoice-payments'){paymentSends++;if(lostPayment){lostPayment=false;throw Error('Réponse paiement perdue');}}if(path==='day-invoice-compensated-sale'){sends++;if(lost){lost=false;throw Error('Réponse perdue');}}return response;
  }});
  const io={transaction,check:transport.check,verifyServer:transport.verifyServer,send:transport.sendCompensation,receipt:transport.readCompensationReceipt};
  const reconciliation={transaction,check:transport.check,verifyServer:transport.verifyServer,read:transport.readCompensatedInvoice};
  // Règlement unique saisi hors ligne : 600 + 250 = 850, payé 800.
  const form=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(form.view.preInvoiceTotal,600000);assert.equal(form.view.salesTotal,250000);assert.equal(form.view.total,850000);assert.equal(form.view.remaining,850000);
  const attempt=makeDayPaymentAttempt(form,clientId,day,{amount:'800,000',mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''},randomUUID(),'2026-01-01T09:30:00.000Z');
  let lostLocal=true;const paymentIO={read:()=>transaction(t=>readDayPaymentAttempt(t,identity)),prepare:(a:typeof attempt)=>transaction(t=>prepareDayPaymentAttempt(t,identity,a,digest)),confirm:async(id:string)=>{const result=await transaction(t=>confirmDayPaymentAttempt(t,identity,id,digest));if(lostLocal){lostLocal=false;throw Error('Réponse locale perdue');}return result;},acknowledge:(id:string)=>transaction(t=>acknowledgeDayPaymentAttempt(t,identity,id)),cancel:(id:string)=>transaction(t=>cancelDayPaymentAttempt(t,identity,id))};
  await assert.rejects(startPaymentAttempt(paymentIO,attempt),/Réponse locale perdue/);
  const payment=await resumePaymentAttempt(paymentIO,attempt);assert.ok(payment.result);await finishPaymentAttempt(paymentIO,attempt);
  assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payments').get()?.n,1);
  const offline=await transaction(t=>captureDayInvoiceForm(t,identity,clientId,day,digest));assert.equal(offline.view.paid,800000);assert.equal(offline.view.remaining,50000);
  const syncIO={...transport,transaction,digest};
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,syncIO),/Réponse paiement perdue/);assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payment_outbox').get()?.n,1);
  assert.deepEqual(await synchronizeDayInvoicePrototype(identity,identity,syncIO),{sources:0,payments:1,remainingSources:0,remainingPayments:0});assert.equal(paymentSends,2);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_payments WHERE operation_id=$1',[attempt.operationId])).rows[0].n,1);
  const lines=[{...sale.lines[0],quantity:3}],draft=await transaction(t=>captureDayInvoiceSaleEdit(t,identity,1,lines,digest));assert.equal(draft.assessment.excess,50000);
  const input={saleId:1,lines,fingerprint:draft.fingerprint,operationId:randomUUID(),recordedAt:'2026-01-01T10:00:00.000Z',choice};
  const saved=await transaction(t=>confirmLocalCompensation(t,identity,input,digest));assert.equal(saved.status,'created');
  await assert.rejects(reconcileCompensatedInvoice(identity,identity,reconciliation),/Reçu de compensation indisponible/);
  const workspace=await transaction(t=>captureWorkspaceState({compensation:()=>readLocalCompensationView(t,identity),preinvoice:async()=>null,sale:async()=>null,saleEdit:async()=>null,payment:async()=>null,oldDebt:async()=>null,clients:async()=>{throw Error('Clients non autorisés');}}));
  assert.deepEqual(workspace,{pending:{kind:'compensation',clientId,day},clients:null});
  await assert.rejects(synchronizeLocalCompensation(identity,{...identity,serverOrigin:'https://autre.test'},io),/différent/);assert.equal(sends,0);
  await assert.rejects(synchronizeLocalCompensation(identity,identity,{...io,verifyServer:async()=>{throw Error('Lignée incohérente.');}}),/Lignée/);assert.equal(sends,0);
  await assert.rejects(synchronizeLocalCompensation(identity,identity,io),/Réponse perdue/);assert.equal((await transaction(t=>readLocalCompensation(t,identity)))?.receipt,null);
  assert.deepEqual(await synchronizeLocalCompensation(identity,identity,io),{status:'proven',operationId:input.operationId});assert.ok((await transaction(t=>readLocalCompensation(t,identity)))?.receipt);
  const view=await transaction(t=>readLocalCompensationView(t,identity));assert.ok(view);assert.equal(view.syncStatus,'proven');assert.equal(view.localBalanceAfter,choice==='refund'?0:-50000);assert.equal(view.serverBalanceAtReceipt,view.localBalanceAfter);assert.equal(view.balanceNeedsReview,false);
  const consolidated=await readCompensatedDayInvoiceSnapshot(pool,input.operationId);
  assert.equal(consolidated.invoice.total,view.total);assert.equal(consolidated.invoice.preInvoiceTotal,view.preInvoiceTotal);assert.equal(consolidated.invoice.salesTotal,view.salesTotalAfter);
  assert.equal(consolidated.invoice.paid,view.paid);assert.equal(consolidated.invoice.applied,view.paidApplied);assert.equal(consolidated.invoice.remaining,view.remaining);
  assert.equal(Number(consolidated.reference.clients.find(c=>c.id===clientId)?.serverBalance),view.localBalanceAfter);
  assert.deepEqual(consolidated.invoice.payments.map(p=>({operationId:p.operationId,amount:p.amount,mode:p.mode})),view.payments.map(p=>({operationId:p.operationId,amount:p.amount,mode:p.mode})));
  const matched=await reconcileCompensatedInvoice(identity,identity,reconciliation);
  assert.deepEqual(matched,{operationId:input.operationId,clientId,day,total:750000,paid:800000,applied:750000,remaining:0,balance:view.localBalanceAfter,balanceNeedsReview:false,journal:{day,gross:800000,refund:choice==='refund'?50000:0,credit:choice==='credit'?50000:0,theoreticalNet:choice==='refund'?750000:800000,clientGross:800000,clientTheoreticalNet:choice==='refund'?750000:800000}});
  const fakeResponse=(data:unknown)=>({ok:true,status:200,json:async()=>data});
  const remote={version:2,compensation:consolidated.compensation,invoice:consolidated.invoice,journal:{commercialId,clientId,...matched.journal}};
  await assert.rejects(reconcileCompensatedInvoice(identity,identity,{...reconciliation,read:async()=>fakeResponse({...remote,invoice:{...remote.invoice,paid:1}})}),/divergentes/);
  await assert.rejects(reconcileCompensatedInvoice(identity,identity,{...reconciliation,read:async()=>fakeResponse({...remote,invoice:{...remote.invoice,payments:[]}})}),/divergentes/);
  await assert.rejects(reconcileCompensatedInvoice(identity,identity,{...reconciliation,read:async()=>fakeResponse({...remote,compensation:{...remote.compensation,choice:choice==='refund'?'credit':'refund'}})}),/divergentes/);
  await assert.rejects(reconcileCompensatedInvoice(identity,identity,{...reconciliation,read:async()=>fakeResponse({...remote,journal:{...remote.journal,theoreticalNet:remote.journal.theoreticalNet+1}})}),/divergentes/);
  await assert.rejects(reconcileCompensatedInvoice(identity,identity,{...reconciliation,read:async()=>fakeResponse({...remote,journal:{...remote.journal,day:'2026-01-02'}})}),/divergentes/);
  let expired=false;await assert.rejects(reconcileCompensatedInvoice(identity,identity,{...reconciliation,check:()=>{if(expired)throw Error('Session expirée');},read:async()=>{expired=true;return fakeResponse(remote);}}),/Session expirée/);
  const localInput=String(db.prepare('SELECT input FROM day_invoice_compensation_local').get()?.input),altered=JSON.parse(localInput),captured=JSON.parse(altered.fingerprint);captured.balance=123456;altered.fingerprint=JSON.stringify(captured);
  await assert.rejects(reconcileCompensatedInvoice(identity,identity,{...reconciliation,read:async()=>{db.prepare('UPDATE day_invoice_compensation_local SET input=?').run(JSON.stringify(altered));return fakeResponse(remote);}}),/divergentes/);
  db.prepare('UPDATE day_invoice_compensation_local SET input=?').run(localInput);
  const changedBalance=await reconcileCompensatedInvoice(identity,identity,{...reconciliation,read:async()=>fakeResponse({...remote,compensation:{...remote.compensation,balance:remote.compensation.balance+1}})});
  assert.equal(changedBalance.balanceNeedsReview,true);assert.equal(changedBalance.balance,view.localBalanceAfter+1);
  assert.equal((await transaction(t=>readLocalCompensation(t,identity)))?.receipt!==null,true);
  const impact=await transaction(t=>readLocalCompensationCollectionImpact(t,identity,commercialId,day));assert.equal(impact.refund,choice==='refund'?50000:0);assert.equal(impact.credit,choice==='credit'?50000:0);
  assert.deepEqual(await synchronizeLocalCompensation(identity,identity,io),{status:'already-proven',operationId:input.operationId});assert.equal(sends,2);
  assert.equal((await transaction(t=>confirmLocalCompensation(t,identity,input,digest))).status,'duplicate');
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_compensations WHERE operation_id=$1',[input.operationId])).rows[0].n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM sale_revisions').get()?.n,1);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,0);
  await assert.rejects(transaction(t=>assertDayInvoiceAttemptsSettled(t,identity)),/Compensation/);
 }finally{phone?.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await pool?.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
