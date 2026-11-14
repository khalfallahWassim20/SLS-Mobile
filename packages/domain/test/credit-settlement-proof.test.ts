import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {canonicalJson} from '@sls/domain';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {storeIdentifiedSettlement} from '../../../apps/api/src/identified-operations.js';
import {readPrototypeCreditReference} from '../../../apps/api/src/credit-note-reference-prototype.js';
import {validatePrototypeCreditReference} from '../../../apps/mobile/credit-note-reference-prototype.js';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {creditReferencePrototypeSchema,savePrototypeCreditReference} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {creditSourcesPrototypeSchema} from '../../../apps/mobile/credit-note-sources-prototype.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {tourCloseQueueSchema} from '../../../apps/mobile/tour-close-queue.js';
import {bindAndCacheCreditReferencePrototype} from '../../../apps/mobile/credit-note-binding-prototype.js';

test('preuve v5 des règlements : contenu entier, corruption et retour arrière refusés',async()=>{
 const db=new PGlite(),phone=new DatabaseSync(':memory:');try{
  await db.exec(schemaSql);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const conn={query:(sql:string,args?:unknown[])=>db.query(sql,args),release:()=>{}};const pool={query:conn.query,connect:async()=>conn} as unknown as Pool;
  const person=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});
  await setCommercialCredentials(pool,'admin',person.id,{login:'proof.test',password:'mot de passe fictif'});
  const secret='secret fictif suffisamment long pour le test',session=await loginCommercial(pool,secret,{login:'proof.test',password:'mot de passe fictif'});assert.ok(session);
  const client=randomUUID(),operationId=randomUUID();await db.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[client,'Client fictif',100000]);
  const payment={syncOperationId:operationId,createdAt:'2026-11-08T09:00:00.000Z',clientId:client,clientName:'Client fictif',amount:5000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  assert.equal(await storeIdentifiedSettlement(pool,{operationId,settlement:payment},{secret,token:session.token,enforceMode:true,creditAware:true}),'received');
  const reference=await readPrototypeCreditReference(pool),parsed=validatePrototypeCreditReference(reference);
  const hash=createHash('sha256').update(canonicalJson(payment)).digest('hex');
  assert.deepEqual(parsed.settlementProofs,[{operationId,hash}]);
  // Simulation complète SQLite de la transition sur un téléphone déjà lié.
  const migrated=new DatabaseSync(':memory:');try{
   migrated.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
    CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);
    CREATE TABLE tour_pre_invoices(id TEXT PRIMARY KEY,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT PRIMARY KEY,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);
    CREATE TABLE journal_sync_state(invoice_id TEXT PRIMARY KEY,version INTEGER,payload TEXT);
    ${identifiedDeviceSchema}${creditReferencePrototypeSchema}${creditSourcesPrototypeSchema}${offlineCreditPrototypeSchema}${tourCloseQueueSchema}`);
   const identity={commercialId:person.id,serverOrigin:'https://api.example.test'};
   migrated.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(person.id,identity.serverOrigin);
   migrated.prepare('INSERT INTO identified_reference_cache VALUES(1,?,?,?)').run(person.id,identity.serverOrigin,JSON.stringify({...reference,version:4}));
   migrated.prepare('INSERT INTO settlements VALUES(1,?,?)').run(client,JSON.stringify({...payment,amount:9000}));
   const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>migrated.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>migrated.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{migrated.prepare(sql).run(...args)}};
   const transaction=async<T>(fn:()=>Promise<T>)=>{migrated.exec('BEGIN');try{const value=await fn();migrated.exec('COMMIT');return value;}catch(e){migrated.exec('ROLLBACK');throw e;}};
   const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');
   await assert.rejects(transaction(()=>bindAndCacheCreditReferencePrototype(tx,identity,identity,reference,digest,()=>{})),/Règlement local sans preuve/);
   assert.equal(migrated.prepare('SELECT count(*) n FROM credit_reference_prototype_cache').get()?.n,0);
   assert.equal(JSON.parse(String(migrated.prepare('SELECT payload FROM settlements').get()?.payload)).amount,9000);
   migrated.prepare('UPDATE settlements SET payload=?').run(JSON.stringify(payment));
   await transaction(()=>bindAndCacheCreditReferencePrototype(tx,identity,identity,reference,digest,()=>{}));
   assert.equal(migrated.prepare('SELECT count(*) n FROM credit_reference_prototype_cache').get()?.n,1);
   assert.equal(migrated.prepare('SELECT payload FROM settlements').get()?.payload,JSON.stringify(payment));
  }finally{migrated.close();}
  assert.throws(()=>validatePrototypeCreditReference({...reference,settlementProofs:[{operationId,hash},{operationId,hash}]}),/Preuve/);
  assert.throws(()=>validatePrototypeCreditReference({...reference,settlementProofs:[{operationId:randomUUID(),hash}]}),/Preuve/);
  phone.exec(`${identifiedDeviceSchema}${creditReferencePrototypeSchema}`);const identity={commercialId:person.id,serverOrigin:'https://api.example.test'};
  phone.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(person.id,identity.serverOrigin);
  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>phone.prepare(sql).get(...args) as T||null,runAsync:async(sql:string,...args:(string|number|null)[])=>{phone.prepare(sql).run(...args)}};
  await savePrototypeCreditReference(tx,identity,identity,reference);
  await assert.rejects(savePrototypeCreditReference(tx,identity,identity,{...reference,settlementProofs:undefined}),/Preuves de règlement manquantes/);
  await assert.rejects(savePrototypeCreditReference(tx,identity,identity,{...reference,settlementProofs:[{operationId,hash:'f'.repeat(64)}]}),/Preuve de règlement périmée/);
  await db.query("UPDATE identified_settlements SET payload=jsonb_set(payload,'{settlement,clientId}',to_jsonb($1::text)) WHERE operation_id=$2",[randomUUID(),operationId]);
  await assert.rejects(readPrototypeCreditReference(pool),/Règlement identifié incohérent/);
 }finally{phone.close();await db.close();}
});
