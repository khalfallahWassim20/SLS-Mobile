/** Test isolé : transport opt-in et aucune route de production. */
import express from 'express';
import {createServer,type Server} from 'node:http';
import {identifiedCommercialRoutes} from '../src/identified-tour-routes.js';
import {saleHistoryRoutes} from '../src/sale-history.js';
import {uploadCompensatedSale} from '../../mobile/day-invoice-compensation-upload.js';
import {readCompensationReceipt} from '../src/day-invoice-compensation-receipt.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {dayInvoiceServerSchema,storeDayInvoicePayment} from '../src/day-invoice-store.js';
import {setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale,storeDayInvoiceCompensatedSale} from '../src/identified-operations.js';
import {storeJournalSnapshot} from '../src/journal-store.js';
import {readServerDayInvoiceSource} from '../src/day-invoice-source.js';
import {readDayInvoiceReference,readDayInvoiceCompensationProjection,readCompensatedDayInvoiceSnapshot} from '../src/day-invoice-reference.js';
import {readIdentifiedJournalDay,readCompensatedJournalDay} from '../src/identified-journal-day.js';

for(const choice of ['refund','credit'] as const)test(`compensation ${choice} : révision atomique, concurrence et reprise`,async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');
 const schema='sls_comp_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined,server:Server|undefined;
 try {
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);
  const clientId=randomUUID(),commercialId=randomUUID(),saleId=randomUUID(),invoiceId=randomUUID(),day='2026-01-01',at='2026-01-01T09:00:00.000Z';
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,100000)',[clientId,'Client fictif']);await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif suffisamment long pour les tests';await setCommercialCredentials(pool,'admin',commercialId,{login:'comp.test',password:'mot de passe fictif'});const login=await loginCommercial(pool,secret,{login:'comp.test',password:'mot de passe fictif'});assert.ok(login);const session={token:login.token,secret};
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Article',code:'X',quantity:1,unitPrice:250000,discount:0,vat:0}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  const creationId=randomUUID();await storeIdentifiedSale(pool,{operationId:creationId,saleId,version:1,recordedAt:at,sale,refund:0},{...session,enforceMode:true});
  const invoice={id:invoiceId,journalDate:day,clientId,clientName:'Client fictif',sector:'',amount:600000,createdAt:at};await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',{...session,enforceMode:true});
  const payment={operationId:randomUUID(),clientId,day,recordedAt:'2026-01-01T09:30:00.000Z',amount:500000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]};await storeDayInvoicePayment(pool,payment,session,readServerDayInvoiceSource);
  const cheque={...payment,operationId:randomUUID(),recordedAt:'2026-01-01T09:45:00.000Z',amount:300000,mode:'Chèque',chequeNumber:'123',chequeBank:'Banque',chequeDue:'2026-02-01',preInvoice:{...payment.preInvoice,declare:false}};
  await storeDayInvoicePayment(pool,cheque,session,readServerDayInvoiceSource);
  // Le remboursement peut être saisi par un autre commercial que celui de la vente.
  const actorId=choice==='refund'?randomUUID():commercialId;
  let editSession=session;
  if(actorId!==commercialId){await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[actorId,'Autre commercial fictif']);await setCommercialCredentials(pool,'admin',actorId,{login:'comp.other',password:'mot de passe fictif'});const actorLogin=await loginCommercial(pool,secret,{login:'comp.other',password:'mot de passe fictif'});assert.ok(actorLogin);editSession={token:actorLogin.token,secret};}
  const eventDay=choice==='refund'?'2026-01-02':day;
  const edit={operationId:randomUUID(),saleId,version:2,recordedAt:`${eventDay}T10:00:00.000Z`,sale:{...sale,syncVersion:2,lines:[{...sale.lines[0],unitPrice:150000}],total:150000,remaining:150000},refund:0};
  const compensation={choice,amount:50000,previousTotal:850000,paid:800000};
  // Un historique illisible ne doit pas pouvoir créer une compensation qui
  // bloquerait ensuite toutes les lectures, même si les montants concordent.
  const originalSale=(await pool.query('SELECT * FROM identified_sale_events WHERE operation_id=$1',[creationId])).rows[0];
  await pool.query('UPDATE identified_sale_events SET payload_hash=$1 WHERE operation_id=$2',['0'.repeat(64),creationId]);
  await assert.rejects(storeDayInvoiceCompensatedSale(pool,edit,compensation,editSession),/non vérifiable/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_sale_events WHERE operation_id=$1',[edit.operationId])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_compensations')).rows[0].n,0);
  await pool.query('UPDATE identified_sale_events SET payload_hash=$1 WHERE operation_id=$2',[originalSale.payload_hash,creationId]);
  // Une vente héritée de l'espace démo ne possède pas la preuve précédente
  // identifiée que le lecteur actuel exige : refuser avant commit.
  await pool.query('DELETE FROM identified_sale_events WHERE operation_id=$1',[creationId]);
  await pool.query('INSERT INTO demo_sale_events(operation_id,sale_id,version,client_id,payload,payload_hash) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[creationId,saleId,1,clientId,JSON.stringify(originalSale.payload),originalSale.payload_hash]);
  await assert.rejects(storeDayInvoiceCompensatedSale(pool,edit,compensation,editSession),/non vérifiable/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_sale_events WHERE operation_id=$1',[edit.operationId])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_compensations')).rows[0].n,0);
  await pool.query('DELETE FROM demo_sale_events WHERE operation_id=$1',[creationId]);
  await pool.query('INSERT INTO identified_sale_events(operation_id,sale_id,version,client_id,commercial_id,journal_date,event_date,payload,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',[creationId,saleId,1,clientId,commercialId,originalSale.journal_date,originalSale.event_date,JSON.stringify(originalSale.payload),originalSale.payload_hash]);
  await assert.rejects(storeDayInvoiceCompensatedSale(pool,{...edit,operationId:randomUUID(),recordedAt:'2026-01-01T09:15:00.000Z'},compensation,editSession),/antérieure à un paiement/);
  for(const invalid of [{...compensation,amount:49999},{...compensation,previousTotal:849999},{...compensation,paid:799999}])await assert.rejects(storeDayInvoiceCompensatedSale(pool,edit,invalid,editSession),/compensation incohérente/);
  const nonExcess={...edit,operationId:randomUUID(),sale:{...edit.sale,lines:[{...sale.lines[0],unitPrice:300000}],total:300000,remaining:300000}};
  await assert.rejects(storeDayInvoiceCompensatedSale(pool,nonExcess,compensation,editSession),/compensation incohérente/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1',[saleId])).rows[0].n,1);
  // Une erreur d'insertion de compensation doit annuler la révision associée.
  await pool.query('ALTER TABLE identified_day_invoice_compensations ADD CONSTRAINT reject_test CHECK (false)');
  await assert.rejects(storeDayInvoiceCompensatedSale(pool,edit,compensation,editSession));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1',[saleId])).rows[0].n,1);
  await pool.query('ALTER TABLE identified_day_invoice_compensations DROP CONSTRAINT reject_test');
  const app=express();app.use(express.json());app.use('/normal',identifiedCommercialRoutes(pool,secret));app.use('/test',identifiedCommercialRoutes(pool,secret,{dayInvoiceTestOnly:true}));app.use('/admin-sales',saleHistoryRoutes(pool));
  server=createServer(app);await new Promise<void>((resolve,reject)=>server!.listen(0,'127.0.0.1',()=>resolve()).once('error',reject));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const historyUrl=`${base}/admin-sales/${saleId}/history`,historyBefore=await fetch(historyUrl);assert.equal(historyBefore.status,200);
  const beforeBody=await historyBefore.json() as {versions:Record<string,unknown>[]};assert.equal(beforeBody.versions.length,1);assert.ok(!('dayInvoiceCompensation' in beforeBody.versions[0]));
  const send=(path:string,body:unknown,token=editSession.token)=>fetch(`${base}/${path}/day-invoice-compensated-sale`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body)});
  assert.equal((await send('normal',{event:edit,compensation})).status,404);
  assert.equal((await send('test',{event:edit,compensation},'invalid')).status,401);
  assert.equal((await send('test',{event:edit})).status,400);
  assert.equal((await send('test',{event:edit,compensation,extra:true})).status,400);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1',[saleId])).rows[0].n,1);
  const responses=await Promise.all([send('test',{event:edit,compensation}),send('test',{event:edit,compensation})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);
  const received=await Promise.all(responses.map(r=>r.json())) as {status:string;operationId:string}[];
  assert.deepEqual(received.map(r=>r.status).sort(),['duplicate','received']);assert.ok(received.every(r=>r.operationId===edit.operationId));
  const historyAfter=await fetch(historyUrl);assert.equal(historyAfter.status,200);assert.match(historyAfter.headers.get('cache-control')??'',/no-store/);
  const afterBody=await historyAfter.json() as {versions:{operationId:string;refund:number;dayInvoiceCompensation?:unknown}[]};
  const changed=afterBody.versions.find(v=>v.operationId===edit.operationId);assert.ok(changed);assert.equal(changed.refund,0);assert.deepEqual(changed.dayInvoiceCompensation,{choice,amount:50000});
  assert.ok(!('dayInvoiceCompensation' in afterBody.versions.find(v=>v.operationId===creationId)!));
  const mismatch=await send('test',{event:edit,compensation:{...compensation,choice:choice==='refund'?'credit':'refund'}});assert.equal(mismatch.status,409);
  const receiptUrl=`${base}/test/day-invoice-compensated-sale/${edit.operationId}/receipt`;
  assert.equal((await fetch(receiptUrl)).status,401);
  assert.equal((await fetch(`${base}/normal/day-invoice-compensated-sale/${edit.operationId}/receipt`,{headers:{Authorization:`Bearer ${editSession.token}`}})).status,404);
  const receiptResponse=await fetch(receiptUrl,{headers:{Authorization:`Bearer ${editSession.token}`}});assert.equal(receiptResponse.status,200);
  const receipt=await receiptResponse.json() as {event:unknown;compensation:unknown;projection:{operationId:string;commercialId:string}};
  assert.deepEqual(receipt.event,edit);assert.deepEqual(receipt.compensation,compensation);assert.equal(receipt.projection.operationId,edit.operationId);assert.equal(receipt.projection.commercialId,actorId);
  if(actorId!==commercialId)assert.equal((await fetch(receiptUrl,{headers:{Authorization:`Bearer ${session.token}`}})).status,409);
  const invoicePath=`day-invoice-compensated-sale/${edit.operationId}/invoice`;
  assert.equal((await fetch(`${base}/normal/${invoicePath}`,{headers:{Authorization:`Bearer ${editSession.token}`}})).status,404);
  assert.equal((await fetch(`${base}/test/${invoicePath}`)).status,401);
  if(actorId!==commercialId)assert.equal((await fetch(`${base}/test/${invoicePath}`,{headers:{Authorization:`Bearer ${session.token}`}})).status,409);
  const invoiceResponse=await fetch(`${base}/test/${invoicePath}`,{headers:{Authorization:`Bearer ${editSession.token}`}});assert.equal(invoiceResponse.status,200);assert.match(invoiceResponse.headers.get('cache-control')??'',/no-store/);
  const invoiceBody=await invoiceResponse.json() as {version:number;invoice:{payments:unknown[];total:number};compensation:{commercialId:string};journal:{day:string;gross:number;refund:number;credit:number;theoreticalNet:number;clientGross:number;clientTheoreticalNet:number}};
  assert.deepEqual(Object.keys(invoiceBody).sort(),['compensation','invoice','journal','version']);assert.equal(invoiceBody.version,3);assert.equal(invoiceBody.compensation.commercialId,actorId);assert.equal(invoiceBody.invoice.total,750000);assert.deepEqual(invoiceBody.invoice.payments,[payment,cheque]);
  assert.deepEqual(invoiceBody.journal,{commercialId:actorId,day:eventDay,clientId,gross:choice==='refund'?0:800000,refund:choice==='refund'?50000:0,credit:choice==='credit'?50000:0,ownRefund:choice==='refund'?50000:0,ownCredit:choice==='credit'?50000:0,theoreticalNet:choice==='refund'?-50000:800000,clientGross:choice==='refund'?0:800000,clientTheoreticalNet:choice==='refund'?-50000:800000});
  // Reprise après réponse perdue : l'acquittement attend le reçu vérifié.
  const identity={commercialId:actorId,serverOrigin:base},payload=JSON.stringify({event:edit,compensation});let acknowledged=0;
  await uploadCompensatedSale(payload,identity,identity,{check:()=>{},send:async p=>send('test',JSON.parse(p)),receipt:async id=>fetch(`${base}/test/day-invoice-compensated-sale/${id}/receipt`,{headers:{Authorization:`Bearer ${editSession.token}`}}),acknowledge:async p=>{assert.equal(p,payload);acknowledged++;}});
  assert.equal(acknowledged,1);
  const stored=await pool.query('SELECT payload,client_id,commercial_id FROM identified_day_invoice_compensations WHERE operation_id=$1',[edit.operationId]);assert.equal(stored.rows.length,1);assert.deepEqual(stored.rows[0].payload,compensation);assert.equal(stored.rows[0].client_id,clientId);assert.equal(stored.rows[0].commercial_id,actorId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1',[saleId])).rows[0].n,2);
  const projection=await readDayInvoiceCompensationProjection(pool,edit.operationId);
  assert.deepEqual(projection,{operationId:edit.operationId,clientId,commercialId:actorId,invoiceDay:day,eventDay,recordedAt:edit.recordedAt,choice,compensation:50000,total:750000,paidBeforeCompensation:800000,applied:750000,remaining:0,balance:choice==='refund'?100000:50000,refund:choice==='refund'?50000:0,credit:choice==='credit'?50000:0});
  assert.equal((await pool.query("SELECT payload->'sale'->>'total' AS total FROM identified_sale_events WHERE operation_id=$1",[edit.operationId])).rows[0].total,'150000');
  const snapshot=await readCompensatedDayInvoiceSnapshot(pool,edit.operationId);
  assert.deepEqual(snapshot.compensation,projection);
  assert.equal(snapshot.reference.clients.find(c=>c.id===clientId)?.serverBalance,String(projection.balance));
  assert.equal(snapshot.reference.saleStates.find(s=>s.saleId===saleId)?.total,'150000');
  assert.equal(snapshot.invoice.preInvoiceTotal,600000);assert.equal(snapshot.invoice.salesTotal,150000);assert.equal(snapshot.invoice.total,750000);
  assert.equal(snapshot.invoice.paid,800000);assert.equal(snapshot.invoice.applied,750000);assert.equal(snapshot.invoice.remaining,0);
  assert.deepEqual(snapshot.invoice.payments,[payment,cheque]);
  const originalDay=await readCompensatedJournalDay(pool,commercialId,day,edit.operationId),originalRow=originalDay.rows.find(r=>r.clientId===clientId);assert.ok(originalRow);
  assert.equal(originalRow.preInvoiceTotal,600000);assert.equal(originalRow.tourTotal,150000);assert.equal(originalRow.totalClient,750000);assert.equal(originalRow.dayInvoicePaid,800000);
  assert.equal(originalDay.totalCollected,800000);assert.equal(originalDay.collectedAfterCompensationRefund,800000);assert.equal(originalDay.compensationRefundTotal,0);assert.equal(originalDay.compensationCreditTotal,choice==='credit'?50000:0);
  const nextDay=await readCompensatedJournalDay(pool,actorId,'2026-01-02',edit.operationId);
  assert.equal(nextDay.totalCollected,0);assert.equal(nextDay.collectedAfterCompensationRefund,choice==='refund'?-50000:0);assert.equal(nextDay.compensationRefundTotal,choice==='refund'?50000:0);assert.equal(nextDay.compensationCreditTotal,0);
  if(choice==='refund'){const nextRow=nextDay.rows.find(r=>r.clientId===clientId);assert.ok(nextRow);assert.equal(nextRow.totalClient,0);assert.equal(nextRow.afterCompensationRefund,-50000);assert.equal(nextRow.compensationRefund,50000);}
  const otherCommercial=randomUUID();await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[otherCommercial,'Autre commercial']);
  const otherJournal=await readCompensatedJournalDay(pool,otherCommercial,eventDay,edit.operationId);assert.equal(otherJournal.compensationEvents.length,0);assert.equal(otherJournal.compensationRefundTotal,0);assert.equal(otherJournal.compensationCreditTotal,0);

  // L'excédent peut compenser une dette ancienne ou créer un crédit net.
  await pool.query('UPDATE clients SET opening_balance=0 WHERE id=$1',[clientId]);
  assert.equal((await readDayInvoiceCompensationProjection(pool,edit.operationId)).balance,choice==='refund'?0:-50000);
  await pool.query('UPDATE clients SET opening_balance=100000 WHERE id=$1',[clientId]);
  const originalHash=(await pool.query('SELECT payload_hash FROM identified_sale_events WHERE operation_id=$1',[edit.operationId])).rows[0].payload_hash;
  await pool.query('UPDATE identified_sale_events SET payload_hash=$1 WHERE operation_id=$2',['0'.repeat(64),edit.operationId]);
  await assert.rejects(readDayInvoiceCompensationProjection(pool,edit.operationId),/Preuve de compensation incohérente/);
  await assert.rejects(readCompensatedDayInvoiceSnapshot(pool,edit.operationId),/Preuve de compensation incohérente/);
  await assert.rejects(readCompensatedJournalDay(pool,actorId,eventDay,edit.operationId),/Preuve de compensation incohérente/);
  await assert.rejects(readCompensationReceipt(pool,edit.operationId,editSession),/Preuve de compensation incohérente/);
  assert.equal((await fetch(historyUrl)).status,500,'historique refuse une preuve altérée');
  await pool.query('UPDATE identified_sale_events SET payload_hash=$1 WHERE operation_id=$2',[originalHash,edit.operationId]);
  assert.equal((await fetch(historyUrl)).status,200);
  const previousHash=(await pool.query('SELECT payload_hash FROM identified_sale_events WHERE operation_id=$1',[creationId])).rows[0].payload_hash;
  await pool.query('UPDATE identified_sale_events SET payload_hash=$1 WHERE operation_id=$2',['0'.repeat(64),creationId]);
  await assert.rejects(readDayInvoiceCompensationProjection(pool,edit.operationId),/Version précédente incohérente/);
  await pool.query('UPDATE identified_sale_events SET payload_hash=$1 WHERE operation_id=$2',[previousHash,creationId]);
  await pool.query('INSERT INTO identified_day_invoice_compensations(operation_id,client_id,commercial_id,invoice_day,event_day,payload,payload_hash) VALUES($1,$2,$3,$4::date,$4::date,$5::jsonb,$6)',[creationId,clientId,commercialId,day,JSON.stringify(compensation),'0'.repeat(64)]);
  await assert.rejects(readDayInvoiceCompensationProjection(pool,edit.operationId),/ambiguë/);
  await assert.rejects(readCompensatedDayInvoiceSnapshot(pool,edit.operationId),/ambiguë/);
  await pool.query('DELETE FROM identified_day_invoice_compensations WHERE operation_id=$1',[creationId]);
  const paymentHash=(await pool.query('SELECT payload_hash FROM identified_day_invoice_payments WHERE operation_id=$1',[cheque.operationId])).rows[0].payload_hash;
  await pool.query('UPDATE identified_day_invoice_payments SET payload_hash=$1 WHERE operation_id=$2',['0'.repeat(64),cheque.operationId]);
  await assert.rejects(readCompensatedDayInvoiceSnapshot(pool,edit.operationId));
  await pool.query('UPDATE identified_day_invoice_payments SET payload_hash=$1 WHERE operation_id=$2',[paymentHash,cheque.operationId]);
  assert.equal((await readCompensatedDayInvoiceSnapshot(pool,edit.operationId)).invoice.applied,750000);



  await assert.rejects(storeDayInvoiceCompensatedSale(pool,edit,{...compensation,choice:choice==='refund'?'credit':'refund'},editSession),/Preuve de compensation incohérente/);
  await assert.rejects(storeIdentifiedSale(pool,edit,{...editSession,enforceMode:true,dayInvoiceAware:true}),/Reprise de compensation incohérente/);
  await pool.query("UPDATE identified_day_invoice_compensations SET payload=jsonb_set(payload,'{amount}','1'::jsonb) WHERE operation_id=$1",[edit.operationId]);
  await assert.rejects(storeDayInvoiceCompensatedSale(pool,edit,compensation,editSession),/Preuve de compensation incohérente/);
  await assert.rejects(readDayInvoiceCompensationProjection(pool,edit.operationId),/Preuve de compensation incohérente/);
  await pool.query('UPDATE identified_day_invoice_compensations SET payload=$1::jsonb WHERE operation_id=$2',[JSON.stringify(compensation),edit.operationId]);
  assert.equal(await storeDayInvoiceCompensatedSale(pool,edit,compensation,editSession),'duplicate');
  // Les écrans/projections non adaptés doivent refuser, pas afficher un faux solde.
  await assert.rejects(readDayInvoiceReference(pool,true),/non projetée/);
  await assert.rejects(readIdentifiedJournalDay(pool,commercialId,day,true),/non projetée/);
  const newPayment={...payment,operationId:randomUUID(),amount:1000,preInvoice:{...payment.preInvoice,declare:false},sales:[{id:saleId,version:2}]};
  await assert.rejects(storeDayInvoicePayment(pool,newPayment,session,readServerDayInvoiceSource),/non projetée/);
 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await pool?.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
