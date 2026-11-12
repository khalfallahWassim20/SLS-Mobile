import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {identifiedCommercialRoutes} from '../../../apps/api/src/identified-tour-routes.js';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema} from '../../../apps/mobile/tour-close-queue.js';
import {offlineCreditPrototypeSchema,readReadyOfflineCreditPrototype,readAllOfflineCreditPrototype,acknowledgeOfflineCreditPrototype} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {readIdentifiedOutbox,acknowledgeIdentifiedOutbox} from '../../../apps/mobile/identified-outbox.js';
import {saveVerifiedCreditReference} from '../../../apps/mobile/credit-note-sync-reference.js';
import {prepareBalancedLocalCredit,readPrototypeCreditBalance} from '../../../apps/mobile/credit-note-balance-storage-prototype.js';
import {assertPrototypeClientActive} from '../../../apps/mobile/credit-note-local-guard.js';
import {activePrototypeClients,validatePrototypeCreditReference} from '../../../apps/mobile/credit-note-reference-prototype.js';
import {saveAndVerifyFinalCreditReference} from '../../../apps/mobile/credit-note-sync-final-prototype.js';
import {syncCreditPrototype} from '../../../apps/mobile/credit-note-sync-prototype.js';

test('parcours v5 isolé : vente hors ligne, avoir, perte de réponse et reprise SQLite–HTTP',async()=>{
 const db=new PGlite(),mobile=new DatabaseSync(':memory:');let server:ReturnType<ReturnType<typeof express>['listen']>|undefined;
 try{
  await db.exec(schemaSql);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>conn,query:conn.query} as unknown as Pool;
  const c=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true}),secret='secret fictif assez long pour les tests';
  await setCommercialCredentials(pool,'admin',c.id,{login:'sync.test',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'sync.test',password:'mot de passe fictif'});assert.ok(session);
  const clientId=randomUUID();await db.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[clientId,'Client fictif',1000000]);
  const app=express();app.use(express.json());app.use('/v5',identifiedCommercialRoutes(pool,secret,{allowCreditProtocol:true}));
  server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));const addr=server.address();assert.ok(addr&&typeof addr!=='string');
  const origin=`http://127.0.0.1:${addr.port}`,identity={commercialId:c.id,serverOrigin:origin};
  const headers={Authorization:`Bearer ${session.token}`,'Content-Type':'application/json','X-SLS-Reference-Version':'5'};
  mobile.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
   CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT PRIMARY KEY,client_id TEXT,journal_date TEXT,payload TEXT);
   CREATE TABLE tour_journal_receipts(id TEXT PRIMARY KEY,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);
   CREATE TABLE journal_sync_state(invoice_id TEXT PRIMARY KEY,version INTEGER,payload TEXT);
   CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,version INTEGER,payload TEXT);
   ${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}`);
  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>mobile.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>mobile.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{mobile.prepare(sql).run(...args)}};
  const transaction=async<T>(action:()=>Promise<T>)=>{mobile.exec('BEGIN');try{const value=await action();mobile.exec('COMMIT');return value;}catch(e){mobile.exec('ROLLBACK');throw e;}};
  const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');
  mobile.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(c.id,origin);
  const getReference=async()=>{const r=await fetch(`${origin}/v5/reference`,{headers});if(!r.ok)throw Error('Référence impossible');return r.json();};
  const initial=await getReference();await transaction(()=>saveVerifiedCreditReference(tx,identity,identity,initial,digest));
  const saleId=randomUUID(),operationId=randomUUID(),at='2026-11-08T09:00:00.000Z';
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  const event={operationId,saleId,version:1,sale,refund:0};
  mobile.prepare('INSERT INTO sales VALUES(1,?,?)').run(clientId,JSON.stringify(sale));
  mobile.prepare('INSERT INTO sales_outbox VALUES(1,?,?,1,?)').run(operationId,saleId,JSON.stringify(event));
  mobile.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(operationId,c.id,'sale',saleId,at);
  const command={operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:'2026-11-08T10:00:00.000Z',choice:'refund' as const};
  const local=await transaction(()=>prepareBalancedLocalCredit(tx,identity,clientId,'sale',command,digest));assert.equal(local.balance,1000000);
  let loseResponse=true;
  const io={
   readOperations:()=>transaction(()=>readIdentifiedOutbox(tx,identity)),
   acknowledgeOperation:(entry:Awaited<ReturnType<typeof readIdentifiedOutbox>>[number])=>transaction(()=>acknowledgeIdentifiedOutbox(tx,identity,entry)),
   readReadyCredits:()=>transaction(()=>readReadyOfflineCreditPrototype(tx,identity)),
   readAllCredits:()=>transaction(()=>readAllOfflineCreditPrototype(tx,identity)),
   acknowledgeCredit:(note:typeof local.note,response:unknown)=>transaction(()=>acknowledgeOfflineCreditPrototype(tx,identity,note,response)),
   sendOperation:(path:string,body:string)=>fetch(`${origin}/v5/${path}`,{method:'POST',headers,body}),
   sendCredit:async(path:string,body:string)=>{const r=await fetch(`${origin}/v5/credit-notes/${path}`,{method:'POST',headers,body});if(loseResponse){loseResponse=false;assert.equal(r.status,201);throw Error('réponse perdue');}return r;},
   fetchReference:getReference,
   saveReference:(a:typeof identity,b:typeof identity,value:unknown)=>transaction(async()=>{await saveVerifiedCreditReference(tx,a,b,value,digest);}),
   saveFinalReference:(a:typeof identity,b:typeof identity,value:unknown)=>transaction(()=>saveAndVerifyFinalCreditReference(tx,a,b,value,digest))
  };
  await assert.rejects(syncCreditPrototype(identity,identity,io),/réponse perdue/);
  assert.equal((await transaction(()=>readIdentifiedOutbox(tx,identity))).length,0);
  assert.equal((await transaction(()=>readReadyOfflineCreditPrototype(tx,identity))).length,1);
  assert.deepEqual(await transaction(()=>readPrototypeCreditBalance(tx,identity,clientId,digest)),{balance:1000000,conflict:false});
  const result=await syncCreditPrototype(identity,identity,io);assert.deepEqual(result,{operations:0,credits:1});
  assert.equal((await transaction(()=>readReadyOfflineCreditPrototype(tx,identity))).length,0);
  assert.deepEqual(await transaction(()=>readPrototypeCreditBalance(tx,identity,clientId,digest)),{balance:1000000,conflict:false});
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM credit_note_prototype_events')).rows[0].n,1);
  // Une nouvelle opération apparue pendant le téléchargement final empêche
  // l'annonce de succès et reste dans la file ; la référence ne doit pas
  // être validée sans contrôle dans la même transaction.
  const extraOp=randomUUID();
  mobile.prepare('INSERT INTO sales_outbox VALUES(2,?,?,1,?)').run(extraOp,saleId,JSON.stringify({...event,operationId:extraOp}));
  mobile.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(extraOp,c.id,'sale',saleId,at);
  const reference=await getReference();
  await assert.rejects(transaction(()=>saveAndVerifyFinalCreditReference(tx,identity,identity,reference,digest)),/opération reste en attente/);
  assert.equal((await transaction(()=>readIdentifiedOutbox(tx,identity))).length,1);
  mobile.prepare('DELETE FROM sales_outbox WHERE operation_id=?').run(extraOp);
  mobile.prepare('DELETE FROM identified_local_operations WHERE operation_id=?').run(extraOp);
  // Un avoir déjà acquitté dont la facture locale a été modifiée est un
  // conflit, même si toutes les requêtes HTTP ont répondu avec succès.
  mobile.prepare('UPDATE sales SET payload=? WHERE id=1').run(JSON.stringify({...sale,lines:[{...sale.lines[0],name:'Modification locale'}]}));
  await assert.rejects(transaction(()=>saveAndVerifyFinalCreditReference(tx,identity,identity,reference,digest)),/modifiée après avoir/);
  mobile.prepare('UPDATE sales SET payload=? WHERE id=1').run(JSON.stringify(sale));
  await transaction(()=>saveAndVerifyFinalCreditReference(tx,identity,identity,reference,digest));
  // Un client désactivé avec des opérations et un avoir acquitté reste
  // rapprochable, mais ne peut plus être choisi pour une nouvelle vente.
  await db.query('UPDATE clients SET active=false WHERE id=$1',[clientId]);
  const inactive=await getReference(),parsed=validatePrototypeCreditReference(inactive);
  assert.equal(activePrototypeClients(parsed).length,0);
  await transaction(()=>saveAndVerifyFinalCreditReference(tx,identity,identity,inactive,digest));
  assert.deepEqual(await transaction(()=>readPrototypeCreditBalance(tx,identity,clientId,digest)),{balance:1000000,conflict:false});
  await assert.rejects(transaction(()=>assertPrototypeClientActive(tx,identity,clientId)),/désactivé/);
  await assert.rejects(transaction(()=>saveAndVerifyFinalCreditReference(tx,identity,identity,reference,digest)),/Statut client périmé/);
  await db.query('UPDATE clients SET active=true WHERE id=$1',[clientId]);
  const reactivated=await getReference();
  await transaction(()=>saveAndVerifyFinalCreditReference(tx,identity,identity,reactivated,digest));
  await transaction(()=>assertPrototypeClientActive(tx,identity,clientId));

 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));mobile.close();await db.close();}
});
