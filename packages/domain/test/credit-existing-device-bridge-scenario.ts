import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {Pool} from 'pg';
import express from 'express';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {identifiedCommercialRoutes} from '../../../apps/api/src/identified-tour-routes.js';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema} from '../../../apps/mobile/tour-close-queue.js';
import {offlineCreditPrototypeSchema,readAllOfflineCreditPrototype,readReadyOfflineCreditPrototype,acknowledgeOfflineCreditPrototype,type Note} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {creditSourcesPrototypeSchema} from '../../../apps/mobile/credit-note-sources-prototype.js';
import {saleEventTimeSchema} from '../../../apps/mobile/sale-event-time.js';
import {bindAndCacheCreditReferencePrototype} from '../../../apps/mobile/credit-note-binding-prototype.js';
import {createCreditTransportPrototype} from '../../../apps/mobile/credit-note-transport-prototype.js';
import {previewLocalCredit,confirmLocalCreditReview} from '../../../apps/mobile/credit-note-review-prototype.js';
import {readPrototypeCreditBalance} from '../../../apps/mobile/credit-note-balance-storage-prototype.js';
import {readIdentifiedOutbox,acknowledgeIdentifiedOutbox} from '../../../apps/mobile/identified-outbox.js';
import {saveVerifiedCreditReference} from '../../../apps/mobile/credit-note-sync-reference.js';
import {saveAndVerifyFinalCreditReference} from '../../../apps/mobile/credit-note-sync-final-prototype.js';
import {syncCreditPrototype} from '../../../apps/mobile/credit-note-sync-prototype.js';
import {assertLegacyMobileCreditSafe} from '../../../apps/mobile/credit-note-write-guard-prototype.js';

export type BridgeDatabase={exec:(sql:string)=>Promise<unknown>;query:<T extends Record<string,unknown>=Record<string,unknown>>(sql:string,args?:unknown[])=>Promise<{rows:T[]}>};
export async function runExistingDeviceBridgeScenario(db:BridgeDatabase,pool:Pool){
 const phone=new DatabaseSync(':memory:');let server:ReturnType<ReturnType<typeof express>['listen']>|undefined;
 try{
  await db.exec(schemaSql);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const person=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});await setCommercialCredentials(pool,'admin',person.id,{login:'bridge.test',password:'mot de passe fictif'});
  const secret='secret fictif suffisamment long pour le test',session=await loginCommercial(pool,secret,{login:'bridge.test',password:'mot de passe fictif'});assert.ok(session);
  const clientId=randomUUID(),saleId=randomUUID(),invoiceId=randomUUID(),at='2026-11-08T09:00:00.000Z',day='2026-11-08';
  await db.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,100000)',[clientId,'Client fictif']);
  const app=express();app.use(express.json());app.use('/v5',identifiedCommercialRoutes(pool,secret,{allowCreditProtocol:true}));server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));
  const addr=server.address();assert.ok(addr&&typeof addr!=='string');const origin=`http://127.0.0.1:${addr.port}`;
  const headers={Authorization:`Bearer ${session.token}`,'Content-Type':'application/json','X-SLS-Reference-Version':'5'};
  const post=async(path:string,body:unknown)=>fetch(`${origin}/v5/${path}`,{method:'POST',headers,body:JSON.stringify(body)});
  const saleOp=randomUUID(),invoiceOp=randomUUID(),receiptOp=randomUUID(),settlementOp=randomUUID();
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  const invoice={id:invoiceId,clientId,clientName:'Client fictif',journalDate:day,createdAt:at,sector:'',amount:600000};
  const receipt={id:randomUUID(),preInvoiceId:invoiceId,clientId,journalDate:day,createdAt:'2026-11-08T10:00:00.000Z',prePaid:250000,oldDebtPaid:20000,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:159000};
  const settlement={syncOperationId:settlementOp,createdAt:'2026-11-08T09:30:00.000Z',clientId,clientName:'Client fictif',amount:10000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  const initial={operationId:invoiceOp,version:1,invoice,receipts:[]},snapshot={operationId:receiptOp,version:2,invoice,receipts:[receipt]};
  assert.equal((await post('sales',{operationId:saleOp,saleId,version:1,recordedAt:at,sale,refund:0})).status,201);
  assert.equal((await post('settlements',{operationId:settlementOp,settlement})).status,201);
  assert.equal((await post('journal',initial)).status,201);assert.equal((await post('journal',snapshot)).status,201);
  const old=await fetch(origin+'/v5/reference',{headers:{Authorization:`Bearer ${session.token}`}});assert.equal(old.status,200);const oldReference=await old.json();assert.equal(oldReference.version,4);
  phone.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE sale_revisions(id INTEGER PRIMARY KEY,sale_id INTEGER,created_at TEXT,previous_payload TEXT,new_payload TEXT,refund INTEGER);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
   CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,version INTEGER,payload TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT PRIMARY KEY,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT PRIMARY KEY,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT PRIMARY KEY,version INTEGER,payload TEXT);
   ${saleEventTimeSchema}${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}${creditSourcesPrototypeSchema}`);
  const identity={commercialId:person.id,serverOrigin:'https://sync.example.test'};
  phone.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(person.id,identity.serverOrigin);phone.prepare('INSERT INTO identified_reference_cache VALUES(1,?,?,?)').run(person.id,identity.serverOrigin,JSON.stringify(oldReference));
  phone.prepare('INSERT INTO sales(client_id,payload) VALUES(?,?)').run(clientId,JSON.stringify(sale));phone.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(invoiceId,clientId,day,JSON.stringify(invoice));
  phone.prepare('INSERT INTO settlements(client_id,payload) VALUES(?,?)').run(clientId,JSON.stringify(settlement));
  phone.prepare('INSERT INTO tour_journal_receipts VALUES(?,?,?,?,?)').run(receipt.id,invoiceId,clientId,day,JSON.stringify(receipt));phone.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(invoiceId,2,JSON.stringify(snapshot));
  for(const [op,kind,id,time] of [[saleOp,'sale',saleId,at],[settlementOp,'settlement',settlementOp,settlement.createdAt],[invoiceOp,'journal',invoiceId,at],[receiptOp,'journal',invoiceId,receipt.createdAt]])phone.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(op,person.id,kind,id,time);
  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>phone.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>phone.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{phone.prepare(sql).run(...args)}};
  const transaction=async<T>(fn:()=>Promise<T>)=>{phone.exec('BEGIN');try{const value=await fn();phone.exec('COMMIT');return value;}catch(e){phone.exec('ROLLBACK');throw e;}};
  const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');let lose=true;
  const controller=createCreditTransportPrototype({id:person.id,name:person.name,serverOrigin:identity.serverOrigin,token:session.token,expiresAt:session.expiresAt},identity,{
   request:async(url,options)=>{const r=await fetch(url.replace(identity.serverOrigin+'/api/mobile/identified',origin+'/v5'),options);if(options.method==='POST'&&url.includes('/credit-notes/')&&lose){lose=false;assert.equal(r.status,201);throw Error('réponse perdue');}return r;},
   bindReference:(id,verified,value,guard)=>transaction(()=>bindAndCacheCreditReferencePrototype(tx,id,verified,value,digest,guard)),
   cacheReference:(id,verified,value,guard)=>transaction(async()=>{guard();await saveVerifiedCreditReference(tx,id,verified,value,digest);guard();}),cacheSources:async()=>{},
   synchronize:(id,verified,transport,guard)=>syncCreditPrototype(id,verified,{
    ...transport,readOperations:()=>transaction(()=>readIdentifiedOutbox(tx,id)),acknowledgeOperation:entry=>transaction(()=>acknowledgeIdentifiedOutbox(tx,id,entry)),
    readReadyCredits:()=>transaction(()=>readReadyOfflineCreditPrototype(tx,id)),readAllCredits:()=>transaction(()=>readAllOfflineCreditPrototype(tx,id)),
    acknowledgeCredit:(note:Note,response:unknown)=>transaction(async()=>{guard();await acknowledgeOfflineCreditPrototype(tx,id,note,response);guard();}),
    saveReference:(a,b,value)=>transaction(async()=>{guard();await saveVerifiedCreditReference(tx,a,b,value,digest);guard();}),
    saveFinalReference:(a,b,value)=>transaction(async()=>{guard();await saveAndVerifyFinalCreditReference(tx,a,b,value,digest);guard();})
   })
  });
  // Une copie locale divergente doit empêcher l'installation v5 sans toucher
  // aux lignes déjà présentes ; la correction dans cet essai est fictive.
  phone.prepare('UPDATE tour_journal_receipts SET payload=?').run(JSON.stringify({...receipt,prePaid:249000}));
  await assert.rejects(controller.connect(),/Préétablie locale/);
  assert.equal(phone.prepare('SELECT count(*) n FROM credit_reference_prototype_cache').get()?.n,0);
  assert.equal(phone.prepare('SELECT payload FROM journal_sync_state').get()?.payload,JSON.stringify(snapshot));
  phone.prepare('UPDATE tour_journal_receipts SET payload=?').run(JSON.stringify(receipt));
  await controller.connect();await assert.rejects(transaction(()=>assertLegacyMobileCreditSafe(tx,identity)),/v5/);
  assert.deepEqual(await transaction(()=>readPrototypeCreditBalance(tx,identity,clientId,digest)),{balance:489000,conflict:false});
  const first={operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:'2026-11-08T11:00:00.000Z',choice:'refund' as const};
  const preview=await transaction(()=>previewLocalCredit(tx,identity,clientId,'sale',first,digest));assert.equal(preview.beforeBalance,489000);assert.equal(preview.afterBalance,420000);
  await transaction(()=>confirmLocalCreditReview(tx,identity,preview,first,digest));
  const second={operationId:randomUUID(),invoiceId,expectedVersion:2,recordedAt:'2026-11-08T11:00:00.000Z',choice:'credit' as const};
  const pre=await transaction(()=>previewLocalCredit(tx,identity,clientId,'preinvoice',second,digest));assert.equal(pre.afterBalance,-180000);
  await transaction(()=>confirmLocalCreditReview(tx,identity,pre,second,digest));assert.equal((await transaction(()=>readAllOfflineCreditPrototype(tx,identity))).filter(x=>x.pending).length,2);
  await assert.rejects(controller.synchronize(),/réponse perdue/);assert.equal((await transaction(()=>readAllOfflineCreditPrototype(tx,identity))).filter(x=>x.pending).length,2);
  assert.deepEqual(await controller.synchronize(),{operations:0,credits:2});assert.deepEqual(await transaction(()=>readPrototypeCreditBalance(tx,identity,clientId,digest)),{balance:-180000,conflict:false});
  assert.deepEqual(await controller.synchronize(),{operations:0,credits:0});
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM credit_note_prototype_events')).rows[0].n,1);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM pre_invoice_credit_prototype_events')).rows[0].n,1);
  assert.equal(phone.prepare('SELECT payload FROM settlements').get()?.payload,JSON.stringify(settlement));
  assert.equal(phone.prepare('SELECT payload FROM tour_journal_receipts').get()?.payload,JSON.stringify(receipt));
  assert.equal(phone.prepare('SELECT payload FROM sales').get()?.payload,JSON.stringify(sale));assert.equal(phone.prepare('SELECT payload FROM journal_sync_state').get()?.payload,JSON.stringify(snapshot));
 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));phone.close();}
}
