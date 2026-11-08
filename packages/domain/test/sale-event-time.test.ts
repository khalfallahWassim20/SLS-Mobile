import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {recordSaleEventTime,saleEventTimeSchema} from '../../../apps/mobile/sale-event-time.js';

test('date locale de version immuable, même transaction que la file',async()=>{
 const db=new DatabaseSync(':memory:');
 try {
  db.exec(saleEventTimeSchema);db.exec(saleEventTimeSchema);
  db.exec('CREATE TABLE outbox(operation_id TEXT PRIMARY KEY)');
  const tx={runAsync:async(sql:string,...params:(string|number|null)[])=>{db.prepare(sql).run(...params);}};
  const id='a1000000-0000-4000-8000-000000000001',at='2026-11-09T15:00:00.000Z';
  db.exec('BEGIN');db.prepare('INSERT INTO outbox VALUES (?)').run(id);await recordSaleEventTime(tx,id,at);db.exec('COMMIT');
  assert.equal((db.prepare('SELECT recorded_at FROM sale_event_times WHERE operation_id=?').get(id) as {recorded_at:string}).recorded_at,at);
  await assert.rejects(recordSaleEventTime(tx,id,at));
  await assert.rejects(recordSaleEventTime(tx,'mauvais',at));
  await assert.rejects(recordSaleEventTime(tx,'a1000000-0000-4000-8000-000000000002','2026-02-30'));
  const next='a1000000-0000-4000-8000-000000000002';
  db.exec('BEGIN');db.prepare('INSERT INTO outbox VALUES (?)').run(next);await recordSaleEventTime(tx,next,at);db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT * FROM outbox WHERE operation_id=?').get(next),undefined);
  assert.equal(db.prepare('SELECT * FROM sale_event_times WHERE operation_id=?').get(next),undefined);
 } finally {db.close();}
});
