import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import express from 'express';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {identifiedCommercialRoutes,identifiedAdminRoutes} from '../../../apps/api/src/identified-tour-routes.js';
import {validateIdentifiedReference} from '../../../apps/mobile/identified-reference.js';
import {uploadIdentifiedOperations,type IdentifiedEntry} from '../../../apps/mobile/identified-upload.js';
import {tourCloseQueueSchema,prepareTourClose,sendPreparedTourClose,acknowledgeTourClose,assertLocalTourWritable,applyReopenedServerState} from '../../../apps/mobile/tour-close-queue.js';

test('parcours isolé : synchronisation, clôture, réponse perdue et réouverture admin',async()=>{
 const serverDb=new PGlite(),mobileDb=new DatabaseSync(':memory:'),secret='secret local pour test global fictif';
 try {
  await serverDb.exec(schemaSql);await serverDb.exec(schemaSql);
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):serverDb.query(sql,params),release:()=>{}};
  const pool={connect:async()=>conn,query:(sql:string,params?:unknown[])=>serverDb.query(sql,params)} as unknown as Pool;
  const commercial=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});
  await setCommercialCredentials(pool,'admin',commercial.id,{login:'commercial.test',password:'mot de passe fictif'});
  const clientId=randomUUID();await serverDb.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[clientId,'Client fictif',1000000]);
  mobileDb.exec(`CREATE TABLE sales_outbox(operation_id TEXT);CREATE TABLE journal_sync_outbox(operation_id TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT);CREATE TABLE sales(payload TEXT);CREATE TABLE settlements(payload TEXT);${tourCloseQueueSchema}`);
  const tx={getFirstAsync:async<T>(sql:string,...params:(string|number|null)[])=>mobileDb.prepare(sql).get(...params) as T||null,runAsync:async(sql:string,...params:(string|number|null)[])=>{mobileDb.prepare(sql).run(...params)}};
  const app=express();app.use(express.json());
  app.post('/login',async(req,res)=>{const result=await loginCommercial(pool,secret,req.body);if(!result){res.sendStatus(401);return;}res.json(result)});
  app.use('/mobile',identifiedCommercialRoutes(pool,secret,{enforceMode:false}));
  app.use('/admin',identifiedAdminRoutes(pool,(req,res,next)=>{if(req.get('Authorization')!=='Bearer admin-fictif'){res.sendStatus(401);return;}next();},'admin-fictif',{enforceMode:false}));
  const server=app.listen(0,'127.0.0.1');
  try {
   await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});
   const a=server.address();if(!a||typeof a==='string')throw Error('Adresse invalide');const origin=`http://127.0.0.1:${a.port}`;
   const post=(path:string,body:unknown,token?:string)=>fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
   const login=await post('/login',{login:'commercial.test',password:'mot de passe fictif'});assert.equal(login.status,200);const {token,commercial:logged}=await login.json();assert.equal(logged.id,commercial.id);
   const identity={commercialId:commercial.id,serverOrigin:origin};
   const day='2026-11-10',createdAt='2026-11-10T08:00:00.000Z';
   const saleId=randomUUID(),saleOp=randomUUID();
   const sale={createdAt,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:210084,discount:0,vat:1900}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
   const saleEvent={operationId:saleOp,saleId,version:1,sale,refund:0};
   const invoiceId=randomUUID(),journalOp=randomUUID(),receiptId=randomUUID();
   const invoice={id:invoiceId,clientId,clientName:'Client fictif',journalDate:day,createdAt,sector:'',amount:600000};
   const receipt={id:receiptId,preInvoiceId:invoiceId,clientId,journalDate:day,createdAt,prePaid:200000,oldDebtPaid:300000,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1000000};
   const journal={operationId:journalOp,version:1,invoice,receipts:[]};
   const paidJournal={operationId:randomUUID(),version:2,invoice,receipts:[receipt]};
   const paymentId=randomUUID(),payment={operationId:paymentId,settlement:{syncOperationId:paymentId,createdAt,clientId,clientName:'Client fictif',amount:30000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}};
   const entries:IdentifiedEntry[]=[{operationId:saleOp,kind:'sale',entityId:saleId,commercialId:commercial.id,recordedAt:createdAt,payload:JSON.stringify(saleEvent)},
    {operationId:paymentId,kind:'settlement',entityId:paymentId,commercialId:commercial.id,recordedAt:createdAt,payload:JSON.stringify(payment)},
    {operationId:journalOp,kind:'journal',entityId:invoiceId,commercialId:commercial.id,recordedAt:createdAt,payload:JSON.stringify(journal)},
    {operationId:paidJournal.operationId,kind:'journal',entityId:invoiceId,commercialId:commercial.id,recordedAt:createdAt,payload:JSON.stringify(paidJournal)}];
   for(const e of entries)mobileDb.prepare(`INSERT INTO ${e.kind==='journal'?'journal_sync_outbox':'sales_outbox'} VALUES(?)`).run(e.operationId);
   await assert.rejects(prepareTourClose(tx,commercial.id,day,0,randomUUID),/attente/);
   const send=(path:string,payload:string)=>fetch(origin+'/mobile/'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:payload});
   const ack=async(operationId:string,kind:string)=>{mobileDb.prepare(`DELETE FROM ${kind==='journal'?'journal_sync_outbox':'sales_outbox'} WHERE operation_id=?`).run(operationId)};
   // La première réponse est perdue après réception ; la même opération est renvoyée.
   let lost=false;
   await assert.rejects(uploadIdentifiedOperations(entries,identity,identity,async(path,payload)=>{const result=await send(path,payload);if(!lost){lost=true;throw Error('coupure simulée');}return result},ack),/coupure/);
   assert.equal(await uploadIdentifiedOperations(entries,identity,identity,send,ack),4);
   const referenceResponse=await fetch(origin+'/mobile/reference',{headers:{Authorization:'Bearer '+token}});assert.equal(referenceResponse.status,200);
   const reference=validateIdentifiedReference(await referenceResponse.json());assert.equal(reference.clients[0].serverBalance,'1320000');
   const detail=await (await fetch(origin+`/mobile/day/${day}/details`,{headers:{Authorization:'Bearer '+token}})).json();
   assert.equal(detail.rows[0].preInvoiceTotal,600000);assert.equal(detail.rows[0].tourTotal,250000);assert.equal(detail.rows[0].totalClient,850000);
   assert.equal(detail.journalCollected,500000);assert.equal(detail.globalSettlementTotal,30000);assert.equal(detail.totalCollected,530000);
   const attempt=await prepareTourClose(tx,commercial.id,day,0,randomUUID);
   await assert.rejects(assertLocalTourWritable(tx,commercial.id,day),/attente/);
   const sendClose=(body:{requestId:string;day:string;expectedVersion:number})=>post('/mobile/close',body,token);
   const closeAck=(body:unknown)=>acknowledgeTourClose(tx,commercial.id,day,body);
   await assert.rejects(sendPreparedTourClose(attempt,async body=>{assert.equal((await sendClose(body)).status,201);throw Error('réponse perdue')},closeAck),/perdue/);
   await sendPreparedTourClose(attempt,sendClose,closeAck);await assert.rejects(assertLocalTourWritable(tx,commercial.id,day),/clôturée/);
   assert.equal((await post('/mobile/journal',journal,token)).status,200);
   const second={...journal,operationId:randomUUID(),version:3,receipts:[receipt,{...receipt,id:randomUUID(),prePaid:10000,oldDebtPaid:0}]};
   assert.equal((await post('/mobile/journal',second,token)).status,409);
   const reopen={requestId:randomUUID(),day,expectedVersion:1};
   assert.equal((await post(`/admin/${commercial.id}/reopen`,reopen,token)).status,401);
   assert.equal((await post(`/admin/${commercial.id}/reopen`,reopen,'admin-fictif')).status,201);
   const state=await (await fetch(origin+`/mobile/day/${day}`,{headers:{Authorization:'Bearer '+token}})).json();
   assert.equal(await applyReopenedServerState(tx,commercial.id,day,state),true);await assertLocalTourWritable(tx,commercial.id,day);
   assert.equal((await post('/mobile/journal',second,token)).status,201);
   assert.equal((await serverDb.query<{n:number}>('SELECT count(*)::int AS n FROM identified_sale_events')).rows[0].n,1);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
 } finally {mobileDb.close();await serverDb.close();}
});
