import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PGlite} from '@electric-sql/pglite';
import express from 'express';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {storeIdentifiedSale} from '../../../apps/api/src/identified-operations.js';
import {storePrototypeCreditNote} from '../../../apps/api/src/credit-note-registry-prototype.js';
import {assignAdminCreditRefund} from '../../../apps/api/src/credit-refund-assignment-prototype.js';
import {identifiedCommercialRoutes} from '../../../apps/api/src/identified-tour-routes.js';
import {saleEventTimeSchema} from '../../../apps/mobile/sale-event-time.js';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema,findTourCloseAttempt,acknowledgeTourClose,acknowledgeAbandonedTourClose,observeVerifiedTourState} from '../../../apps/mobile/tour-close-queue.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {creditSourcesPrototypeSchema} from '../../../apps/mobile/credit-note-sources-prototype.js';
import {remoteSaleDraftPrototypeSchema,remoteSaleConfirmPrototypeSchema} from '../../../apps/mobile/credit-remote-sale-schema-prototype.js';
import {bindAndCacheCreditReferencePrototype} from '../../../apps/mobile/credit-note-binding-prototype.js';
import {saveVerifiedCreditReference} from '../../../apps/mobile/credit-note-sync-reference.js';
import {prepareVerifiedPrototypeClose} from '../../../apps/mobile/credit-note-verified-close-prototype.js';
import {readCreditJournalExportPrototype} from '../../../apps/mobile/credit-note-journal-export-prototype.js';
import {describeCreditJournalPrototype} from '../../../apps/mobile/credit-note-journal-view-model-prototype.js';
import {createCreditTransportPrototype} from '../../../apps/mobile/credit-note-transport-prototype.js';

test('téléphone v5 : attribution arrivée après capture, abandon sûr, synchronisation et réponse perdue',async()=>{
 const db=new PGlite(),mobile=new DatabaseSync(':memory:');let server:ReturnType<ReturnType<typeof express>['listen']>|undefined;
 try{
  await db.exec(schemaSql);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}},pool={query:(sql:string,params?:unknown[])=>db.query(sql,params),connect:async()=>conn} as unknown as Pool;
  const owner=await saveCommercial(pool,'admin',{name:'A',active:true}),actor=await saveCommercial(pool,'admin',{name:'B',active:true});
  await setCommercialCredentials(pool,'admin',owner.id,{login:'proof.owner',password:'mot de passe fictif'});await setCommercialCredentials(pool,'admin',actor.id,{login:'proof.actor',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour les tests',a=await loginCommercial(pool,secret,{login:'proof.owner',password:'mot de passe fictif'}),b=await loginCommercial(pool,secret,{login:'proof.actor',password:'mot de passe fictif'});assert.ok(a&&b);
  const day='2026-11-08',at=day+'T09:00:00.000Z',clientId=randomUUID(),saleId=randomUUID();await db.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Client fictif']);
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Huile',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},{secret,token:a.token,enforceMode:true,creditAware:true});
  const command={operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:day+'T10:00:00.000Z',choice:'refund' as const};await storePrototypeCreditNote(pool,command,{kind:'admin',actorId:'admin'});
  const app=express();app.use(express.json());app.use('/v5',identifiedCommercialRoutes(pool,secret,{allowCreditProtocol:true}));server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server!.once('listening',r));const addr=server.address();assert.ok(addr&&typeof addr!=='string');const origin=`http://127.0.0.1:${addr.port}`,identity={commercialId:actor.id,serverOrigin:'https://sync.example.test'};
  mobile.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE sale_revisions(id INTEGER PRIMARY KEY,sale_id INTEGER,created_at TEXT,previous_payload TEXT,new_payload TEXT,refund INTEGER);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
   CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);CREATE TABLE tour_pre_invoices(id TEXT PRIMARY KEY,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT PRIMARY KEY,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);
   CREATE TABLE journal_sync_state(invoice_id TEXT PRIMARY KEY,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,version INTEGER,payload TEXT);
   ${saleEventTimeSchema}${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}${creditSourcesPrototypeSchema}${remoteSaleDraftPrototypeSchema}${remoteSaleConfirmPrototypeSchema}`);
  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>mobile.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>mobile.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{mobile.prepare(sql).run(...args)}};
  const transaction=async<T>(fn:()=>Promise<T>)=>{mobile.exec('BEGIN');try{const x=await fn();mobile.exec('COMMIT');return x;}catch(e){mobile.exec('ROLLBACK');throw e;}};
  const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');
  const reference=async()=>{const r=await fetch(origin+'/v5/reference',{headers:{Authorization:`Bearer ${b.token}`,'X-SLS-Reference-Version':'5'}});assert.equal(r.status,200);return r.json();};
  const initial=await reference();await transaction(()=>bindAndCacheCreditReferencePrototype(tx,identity,identity,initial,digest,()=>{}));
  const assignment={requestId:randomUUID(),noteOperationId:command.operationId,refund:50000,commercialId:actor.id};await assignAdminCreditRefund(pool,assignment,'admin');
  let loseAbandon=true,loseClose=true;
  const controller=createCreditTransportPrototype({id:actor.id,name:'B',serverOrigin:identity.serverOrigin,token:b.token,expiresAt:b.expiresAt},identity,{
   request:async(url,options)=>{const r=await fetch(url.replace(identity.serverOrigin+'/api/mobile/identified',origin+'/v5'),options);if(url.endsWith('/close/abandon')&&loseAbandon){loseAbandon=false;assert.equal(r.status,200);throw Error('réponse abandon perdue');}if(url.endsWith('/close')&&r.status===201&&loseClose){loseClose=false;throw Error('réponse clôture perdue');}return r;},
   cacheReference:(x,y,v,guard)=>transaction(async()=>{guard();await saveVerifiedCreditReference(tx,x,y,v,digest);guard();}),
   cacheSources:async()=>{},synchronize:async()=>({operations:0,credits:0}),
   tour:{getAttempt:(id,d,guard)=>transaction(async()=>{guard();return findTourCloseAttempt(tx,id.commercialId,d);}),
    prepare:(id,d,v,guard)=>transaction(async()=>{guard();return prepareVerifiedPrototypeClose(tx,id,d,v,randomUUID,digest);}),
    acknowledge:(id,d,response,guard)=>transaction(async()=>{guard();await acknowledgeTourClose(tx,id.commercialId,d,response);guard();}),
    discard:(id,d,attempt,response,guard)=>transaction(async()=>{guard();await acknowledgeAbandonedTourClose(tx,id.commercialId,d,attempt,response);guard();}),
    observe:(id,d,response,guard)=>transaction(async()=>{guard();await observeVerifiedTourState(tx,id.commercialId,d,response);guard();})}
  });
  await assert.rejects(controller.closeDay(day),/réponse abandon perdue/);const stale=await transaction(()=>findTourCloseAttempt(tx,actor.id,day));assert.ok(stale);assert.deepEqual(stale.adminRefundProof,[]);
  await assert.rejects(controller.closeDay(day),/Synchronisez, vérifiez le journal/);assert.equal(await transaction(()=>findTourCloseAttempt(tx,actor.id,day)),null);
  await controller.refreshReference();const data=await transaction(()=>readCreditJournalExportPrototype(tx,identity,day,'B',digest));const model=describeCreditJournalPrototype(data);
  assert.equal(model.adminCreditRefundTotal,50000);assert.equal(model.totals.collectedAfterLocalRefunds,-50000);
  await assert.rejects(controller.closeDay(day),/réponse clôture perdue/);const sent=await transaction(()=>findTourCloseAttempt(tx,actor.id,day));assert.deepEqual(sent?.adminRefundProof,[{noteOperationId:command.operationId,assignmentId:assignment.requestId,refund:50000}]);
  assert.deepEqual(await controller.closeDay(day),{status:'closed',version:1});assert.equal((await transaction(()=>findTourCloseAttempt(tx,actor.id,day)))?.status,'closed');
  // Un autre téléphone clôture après préparation : le conflit n'efface que
  // la tentative réservée au serveur, puis l'état fermé est observé.
  const secondDay='2026-11-09';const secondAttempt=await transaction(()=>prepareVerifiedPrototypeClose(tx,identity,secondDay,0,randomUUID,digest));
  const other=await fetch(origin+'/v5/close',{method:'POST',headers:{Authorization:`Bearer ${b.token}`,'X-SLS-Reference-Version':'5','Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),day:secondDay,expectedVersion:0,adminRefundProof:[]})});assert.equal(other.status,201);
  await assert.rejects(controller.closeDay(secondDay),/Synchronisez, vérifiez le journal/);assert.equal(await transaction(()=>findTourCloseAttempt(tx,actor.id,secondDay)),null);
  assert.ok(secondAttempt.adminRefundProof);assert.deepEqual(await controller.refreshDay(secondDay),{status:'closed',version:1});

 }finally{mobile.close();if(server)await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve()));await db.close();}
});
