import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {readIdentifiedOutbox,acknowledgeIdentifiedOutbox} from '../../../apps/mobile/identified-outbox.js';

test('file individuelle : ordre, identité et accusé transactionnel',async()=>{
 const db=new DatabaseSync(':memory:');
 try {
  db.exec(`CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,payload TEXT);
    CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);${identifiedDeviceSchema}`);
  const tx={getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[],getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null,runAsync:async(sql:string,...args:(string|number|null)[])=>{db.prepare(sql).run(...args)}};
  const identity={commercialId:'alice',serverOrigin:'https://example.test'};
  db.exec(`INSERT INTO identified_device VALUES(1,'alice','https://example.test');
   INSERT INTO sales_outbox VALUES(1,'a','vente','{"a":1}'),(2,'b','paiement','{"b":2}');
   INSERT INTO journal_sync_outbox VALUES(1,'c','facture','{"c":3}');
   INSERT INTO identified_local_operations VALUES('a','alice','sale','vente','2026-11-10T12:00:00.000Z'),('b','alice','settlement','paiement','2026-11-10T12:00:01.000Z'),('c','alice','journal','facture','2026-11-10T12:00:02.000Z')`);
  const rows=await readIdentifiedOutbox(tx,identity);assert.deepEqual(rows.map(r=>r.operationId),['a','b','c']);
  await assert.rejects(readIdentifiedOutbox(tx,{...identity,commercialId:'bob'}),/[Ii]dentité/);
  await assert.rejects(readIdentifiedOutbox(tx,{...identity,serverOrigin:'https://other.test'}),/[Ii]dentité/);
  await assert.rejects(acknowledgeIdentifiedOutbox(tx,identity,{...rows[0],payload:'{}'}),/accusé/);
  db.exec('BEGIN');await acknowledgeIdentifiedOutbox(tx,identity,rows[0]);db.exec('ROLLBACK');
  assert.equal((await readIdentifiedOutbox(tx,identity)).length,3);
  await acknowledgeIdentifiedOutbox(tx,identity,rows[0]);assert.equal((await readIdentifiedOutbox(tx,identity)).length,2);
  assert.ok(db.prepare('SELECT * FROM identified_local_operations WHERE operation_id=?').get('a'));
  await assert.rejects(acknowledgeIdentifiedOutbox(tx,identity,rows[0]),/accusé/);
  db.exec("DELETE FROM identified_local_operations WHERE operation_id='c'");
  await assert.rejects(readIdentifiedOutbox(tx,identity),/rapprochement/);
 }finally{db.close();}
});
