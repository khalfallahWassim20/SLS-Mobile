import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema} from '../../../apps/mobile/tour-close-queue.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {preparePrototypeClose} from '../../../apps/mobile/credit-note-close-prototype.js';

test('clôture expérimentale : refuse tout avoir en attente et conserve les données',async()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(`CREATE TABLE sales_outbox(operation_id TEXT);CREATE TABLE journal_sync_outbox(operation_id TEXT);CREATE TABLE tour_pre_invoices(id TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT);CREATE TABLE sales(payload TEXT);CREATE TABLE settlements(payload TEXT);${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}`);
  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null,runAsync:async(sql:string,...args:(string|number|null)[])=>{db.prepare(sql).run(...args)}};
  const identity={commercialId:randomUUID(),serverOrigin:'https://example.test'},operation=randomUUID(),invoice=randomUUID();
  db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);
  db.prepare('INSERT INTO offline_credit_prototype VALUES(?,?,?,?,?,?,1)').run(operation,invoice,'sale',identity.commercialId,identity.serverOrigin,'{}');
  await assert.rejects(preparePrototypeClose(tx,identity,'2026-11-08',0,randomUUID),/avoir est en attente/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM tour_close_attempts').get()?.n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM offline_credit_prototype WHERE pending=1').get()?.n,1);
  await assert.rejects(preparePrototypeClose(tx,{...identity,serverOrigin:'https://other.test'},'2026-11-08',0,randomUUID),/Identité/);
  db.prepare('UPDATE offline_credit_prototype SET pending=0').run();
  const result=await preparePrototypeClose(tx,identity,'2026-11-08',0,randomUUID);
  assert.equal(result.status,'closing');assert.equal(db.prepare('SELECT count(*) AS n FROM offline_credit_prototype').get()?.n,1);
  db.prepare('INSERT INTO sales_outbox(operation_id) VALUES(?)').run(randomUUID());
  await assert.rejects(preparePrototypeClose(tx,identity,'2026-11-08',0,randomUUID),/opération est en attente/);
  assert.equal((await prepareAfterDelete()).requestId,result.requestId);
  async function prepareAfterDelete(){db.exec('DELETE FROM sales_outbox');return preparePrototypeClose(tx,identity,'2026-11-08',0,randomUUID);}
 }finally{db.close();}
});
