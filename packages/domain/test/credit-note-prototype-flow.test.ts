import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PGlite} from '@electric-sql/pglite';
import express from 'express';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {creditNotePrototypeSchema} from '../../../apps/api/src/credit-note-registry-prototype.js';
import {preInvoiceCreditPrototypeSchema} from '../../../apps/api/src/pre-invoice-credit-registry-prototype.js';
import {prototypeAdminCreditRoutes,prototypeCommercialCreditRoutes} from '../../../apps/api/src/credit-note-routes-prototype.js';
import {storeIdentifiedSale} from '../../../apps/api/src/identified-operations.js';
import {storeJournalSnapshot} from '../../../apps/api/src/journal-store.js';
import {changeTourClosure} from '../../../apps/api/src/tour-closure-store.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial,verifyCommercialSession} from '../../../apps/api/src/commercial-session.js';
import {readPrototypeCreditReference} from '../../../apps/api/src/credit-note-reference-prototype.js';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema} from '../../../apps/mobile/tour-close-queue.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {offlineCreditPrototypeSchema,prepareOfflineCreditPrototype,readReadyOfflineCreditPrototype,readAllOfflineCreditPrototype,acknowledgeOfflineCreditPrototype} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {uploadPrototypeCreditNotes} from '../../../apps/mobile/credit-note-upload-prototype.js';
import {ClosedDaySyncError} from '../../../apps/mobile/identified-upload.js';
import {syncCreditPrototype} from '../../../apps/mobile/credit-note-sync-prototype.js';
import {saveVerifiedCreditReference} from '../../../apps/mobile/credit-note-sync-reference.js';

test('avoir expérimental de bout en bout : file locale, HTTP, reprise et clôture',async()=>{
 const db=new PGlite(),mobile=new DatabaseSync(':memory:');let server:ReturnType<ReturnType<typeof express>['listen']>|undefined;
 try {
  await db.exec(schemaSql);await db.exec(creditNotePrototypeSchema);await db.exec(preInvoiceCreditPrototypeSchema);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>conn,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  const c=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true}),secret='secret uniquement pour le test';
  await setCommercialCredentials(pool,'admin',c.id,{login:'credit.test',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'credit.test',password:'mot de passe fictif'});assert.ok(session);
  const app=express();app.use(express.json());app.use('/commercial',prototypeCommercialCreditRoutes(pool,secret));
  app.get('/reference',async(req,res,next)=>{try{const actor=await verifyCommercialSession(pool,secret,req.get('Authorization')?.replace(/^Bearer /,'')??'');if(!actor){res.sendStatus(401);return;}res.json(await readPrototypeCreditReference(pool));}catch(error){next(error);}});
  app.use('/admin',prototypeAdminCreditRoutes(pool,(req,res,next)=>{if(req.get('Authorization')!=='Bearer admin-test')res.status(401).json({error:'Admin requis'});else next();},'admin'));
  server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`,identity={commercialId:c.id,serverOrigin:origin};
  mobile.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,payload TEXT);CREATE TABLE sales_outbox(operation_id TEXT,sale_id TEXT,payload TEXT);
   CREATE TABLE journal_sync_outbox(operation_id TEXT,invoice_id TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(pre_invoice_id TEXT,payload TEXT);
   ${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}`);
  const tx={getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>mobile.prepare(sql).all(...args) as T[],getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>mobile.prepare(sql).get(...args) as T||null,runAsync:async(sql:string,...args:(string|number|null)[])=>{mobile.prepare(sql).run(...args)}};
  mobile.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(c.id,origin);
  const clientId=randomUUID(),saleId=randomUUID(),op=randomUUID(),at='2026-11-08T09:00:00.000Z';await db.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Client fictif']);
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:op,saleId,version:1,recordedAt:at,sale,refund:0},{secret,token:session.token});
  mobile.prepare('INSERT INTO sales VALUES(1,?)').run(JSON.stringify(sale));mobile.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(op,c.id,'sale',saleId,at);
  mobile.prepare('INSERT INTO sales_outbox VALUES(?,?,?)').run(op,saleId,'{}');
  const command={operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:'2026-11-08T10:00:00.000Z',choice:'refund' as const};
  const note=await prepareOfflineCreditPrototype(tx,identity,'sale',command);assert.equal(note.refund,50000);
  assert.equal((await readReadyOfflineCreditPrototype(tx,identity)).length,0);mobile.prepare('DELETE FROM sales_outbox').run();
  const send=(path:string,body:string)=>fetch(`${origin}/commercial/${path}`,{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},body});
  const ack=async(n:typeof note,response:unknown)=>{mobile.exec('BEGIN');try{await acknowledgeOfflineCreditPrototype(tx,identity,n,response);mobile.exec('COMMIT');}catch(e){mobile.exec('ROLLBACK');throw e;}};
  // Le serveur reçoit la commande, mais le téléphone perd la réponse.
  await assert.rejects(uploadPrototypeCreditNotes([note],identity,identity,async(path,body)=>{const response=await send(path,body);assert.equal(response.status,201);throw Error('réponse perdue');},ack),/perdue/);
  assert.equal((await readReadyOfflineCreditPrototype(tx,identity)).length,1);
  const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');
  const synced=await syncCreditPrototype(identity,identity,{
   readOperations:async()=>[],acknowledgeOperation:async()=>{throw Error('Aucune opération attendue');},
   readReadyCredits:()=>readReadyOfflineCreditPrototype(tx,identity),readAllCredits:()=>readAllOfflineCreditPrototype(tx,identity),
   acknowledgeCredit:ack,sendOperation:async()=>{throw Error('Aucun envoi attendu');},sendCredit:send,
   fetchReference:async()=>{const response=await fetch(`${origin}/reference`,{headers:{Authorization:`Bearer ${session.token}`}});if(!response.ok)throw Error('Référence indisponible');return response.json();},
   saveReference:async(a,b,value)=>{mobile.exec('BEGIN');try{await saveVerifiedCreditReference(tx,a,b,value,digest);mobile.exec('COMMIT');}catch(e){mobile.exec('ROLLBACK');throw e;}},
   saveFinalReference:async(a,b,value)=>{mobile.exec('BEGIN');try{await saveVerifiedCreditReference(tx,a,b,value,digest);mobile.exec('COMMIT');}catch(e){mobile.exec('ROLLBACK');throw e;}}
  });assert.deepEqual(synced,{operations:0,credits:1});
  assert.equal((await readReadyOfflineCreditPrototype(tx,identity)).length,0);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM credit_note_prototype_events')).rows[0].n,1);
  // Un administrateur non authentifié ne peut pas utiliser le routeur de test.
  const adminResponse=await fetch(`${origin}/admin/sales`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...command,operationId:randomUUID()})});assert.equal(adminResponse.status,401);
  // Préétablie créée localement ; la journée est fermée sur le serveur après préparation.
  const invoiceId=randomUUID(),journalOp=randomUUID(),day='2026-11-09';
  const invoice={id:invoiceId,clientId,clientName:'Client fictif',journalDate:day,createdAt:'2026-11-09T09:00:00.000Z',sector:'',amount:600000};
  const snapshot={operationId:journalOp,version:1,invoice,receipts:[]};
  await storeJournalSnapshot(pool,snapshot,'identified',{secret,token:session.token});
  mobile.prepare('INSERT INTO tour_pre_invoices VALUES(?,?)').run(invoiceId,JSON.stringify(invoice));
  mobile.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(invoiceId,1,JSON.stringify(snapshot));
  mobile.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(journalOp,c.id,'journal',invoiceId,invoice.createdAt);
  const pre=await prepareOfflineCreditPrototype(tx,identity,'preinvoice',{operationId:randomUUID(),invoiceId,expectedVersion:1,recordedAt:'2026-11-09T10:00:00.000Z',choice:null});
  const collision=await send('preinvoices',JSON.stringify({...pre.command,operationId:command.operationId}));assert.equal(collision.status,409);
  await changeTourClosure(pool,c.id,day,'close',{id:c.id,role:'commercial'},0);
  await assert.rejects(uploadPrototypeCreditNotes([pre],identity,identity,send,ack),e=>e instanceof ClosedDaySyncError&&e.day===day);
  assert.equal((await readReadyOfflineCreditPrototype(tx,identity)).length,1);
  await changeTourClosure(pool,c.id,day,'reopen',{id:'admin',role:'admin'},1);
  assert.equal(await uploadPrototypeCreditNotes([pre],identity,identity,send,ack),1);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM pre_invoice_credit_prototype_events')).rows[0].n,1);
  const otherSaleId=randomUUID(),otherSale={...sale,syncSaleId:otherSaleId};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId:otherSaleId,version:1,recordedAt:at,sale:otherSale,refund:0},{secret,token:session.token});
  const cross={...command,invoiceId:otherSaleId,operationId:pre.command.operationId};
  assert.equal((await send('sales',JSON.stringify(cross))).status,409);
  const adminCmd={...cross,operationId:randomUUID()};
  const adminOk=await fetch(`${origin}/admin/sales`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer admin-test'},body:JSON.stringify(adminCmd)});assert.equal(adminOk.status,201);
  const adminEvent=await db.query<{event:{actor:{role:string}}}>('SELECT event FROM credit_note_prototype_events WHERE operation_id=$1',[adminCmd.operationId]);assert.equal(adminEvent.rows[0].event.actor.role,'admin');
 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));mobile.close();await db.close();}
});
