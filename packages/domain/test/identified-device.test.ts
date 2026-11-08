import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../src/index.js';
import {identifiedDeviceSchema,bindVerifiedDevice,getDeviceIdentity,recordDeviceOperation,assertKnownDeviceEntity,assertDeviceWritable,saveVerifiedIdentifiedReference} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema,prepareTourClose} from '../../../apps/mobile/tour-close-queue.js';
const id='a1000000-0000-4000-8000-000000000001',other='a1000000-0000-4000-8000-000000000002',op='a1000000-0000-4000-8000-000000000003',entity='a1000000-0000-4000-8000-000000000004',request='a1000000-0000-4000-8000-000000000005',day='2026-11-10',time='2026-11-10T12:00:00.000Z';
test('liaison isolée : anciennes files préservées, identité immuable et opérations traçables',async()=>{
 const db=new DatabaseSync(':memory:');
 try {
  db.exec(`CREATE TABLE sales_outbox(operation_id TEXT);CREATE TABLE journal_sync_outbox(operation_id TEXT);CREATE TABLE tour_pre_invoices(id TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT);CREATE TABLE sales(payload TEXT);CREATE TABLE settlements(payload TEXT);${identifiedDeviceSchema}${identifiedDeviceSchema}${tourCloseQueueSchema}`);
  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null,runAsync:async(sql:string,...args:(string|number|null)[])=>{db.prepare(sql).run(...args)}};
  const identity={commercialId:id,serverOrigin:'http://192.168.1.10:3001'};
  db.exec("INSERT INTO sales_outbox VALUES('ancienne')");
  await assert.rejects(bindVerifiedDevice(tx,identity),/Synchronisez/);assert.equal(await getDeviceIdentity(tx),null);
  assert.equal((db.prepare('SELECT count(*) AS n FROM sales_outbox').get() as {n:number}).n,1);
  db.exec('DELETE FROM sales_outbox');
  db.exec("INSERT INTO tour_pre_invoices VALUES('ancienne')");
  await assert.rejects(bindVerifiedDevice(tx,identity),/Synchronisez/);db.exec('DELETE FROM tour_pre_invoices');
  await bindVerifiedDevice(tx,identity);assert.deepEqual({...await getDeviceIdentity(tx)},identity);
  await bindVerifiedDevice(tx,identity);
  await assert.rejects(bindVerifiedDevice(tx,{...identity,commercialId:other}),/déjà lié/);
  await assert.rejects(bindVerifiedDevice(tx,{...identity,serverOrigin:'http://192.168.1.11:3001'}),/déjà lié/);
  await assert.rejects(assertKnownDeviceEntity(tx,identity,'sale',entity),/rapprochement/);
  const previous={clientId:other,version:2,total:119000,paid:50000};
  const reference={version:4,clients:[{id:other,name:'Fictif',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'69000'}],articles:[],saleStates:[{saleId:entity,clientId:other,version:2,total:'119000',paid:'50000'}],settlementStates:[],journalStates:[],journalProofs:[]};
  await assert.rejects(saveVerifiedIdentifiedReference(tx,identity,{...identity,commercialId:other},reference),/Session/);
  await assert.rejects(saveVerifiedIdentifiedReference(tx,identity,identity,{...reference,version:3}),/invalide/);
  await saveVerifiedIdentifiedReference(tx,identity,identity,reference);
  await assertKnownDeviceEntity(tx,identity,'sale',entity,previous);
  await assert.rejects(assertKnownDeviceEntity(tx,identity,'sale',entity,{...previous,version:1}),/rapprochement/);
  await assert.rejects(assertKnownDeviceEntity(tx,identity,'journal',entity),/rapprochement/);
  const snapshot={operationId:op,version:2,invoice:{id:entity,clientId:other,journalDate:day,amount:1000},receipts:[]};
  const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');
  const journalRef={...reference,journalStates:[{id:entity,clientId:other,journalDate:day,total:1000,receipts:[]}],journalProofs:[{id:entity,version:2,hash:await digest(canonicalJson(snapshot))}]};
  await saveVerifiedIdentifiedReference(tx,identity,identity,journalRef);
  const previousJournal={version:2,payload:JSON.stringify(snapshot),digest};
  await assertKnownDeviceEntity(tx,identity,'journal',entity,undefined,previousJournal);
  await assert.rejects(assertKnownDeviceEntity(tx,identity,'journal',entity,undefined,{...previousJournal,version:1}),/rapprochement/);
  await assert.rejects(assertKnownDeviceEntity(tx,identity,'journal',entity,undefined,{...previousJournal,payload:JSON.stringify({...snapshot,invoice:{...snapshot.invoice,amount:2000}})}),/rapprochement/);
  await assert.rejects(assertKnownDeviceEntity(tx,{...identity,serverOrigin:'http://autre:3001'},'journal',entity,undefined,previousJournal),/rapprochement/);
  await assert.rejects(saveVerifiedIdentifiedReference(tx,identity,identity,{...journalRef,journalProofs:[]}),/Preuves/);
  await assert.rejects(saveVerifiedIdentifiedReference(tx,identity,identity,{...journalRef,journalProofs:[{...journalRef.journalProofs[0],hash:'bad'}]}),/Preuve/);

  // La suite vérifie que la date et l'identité sont enregistrées atomiquement.
  db.exec('BEGIN');await recordDeviceOperation(tx,identity,op,'sale',entity,time);db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT operation_id FROM identified_local_operations WHERE operation_id=?').get(op),undefined);
  await recordDeviceOperation(tx,identity,op,'sale',entity,time);
  await assertKnownDeviceEntity(tx,identity,'sale',entity);
  await assert.rejects(assertKnownDeviceEntity(tx,{...identity,commercialId:other},'sale',entity),/rapprochement/);
  await assertDeviceWritable(tx,identity,[day]);
  await prepareTourClose(tx,id,day,0,()=>request);
  await assert.rejects(assertDeviceWritable(tx,identity,[day]),/Clôture en attente/);
  await assertDeviceWritable(tx,identity,['2026-11-11']);
  await assertDeviceWritable(tx,null,[day]); // ancien mode inchangé, clôture pas activée
 } finally {db.close();}
});
