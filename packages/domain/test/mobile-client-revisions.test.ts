import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {readClientRevisions} from '../../../apps/mobile/client-revisions.js';
test('révisions d’un client : une lecture protégée, tri et isolation',async()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE sale_revisions(id INTEGER PRIMARY KEY,sale_id INTEGER,created_at TEXT,previous_payload TEXT,new_payload TEXT,refund INTEGER);${identifiedDeviceSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}`);
  db.exec("INSERT INTO sales VALUES(1,'a','{}'),(2,'a','{}'),(3,'b','{}'); INSERT INTO sale_revisions VALUES(1,1,'2026-01-01','{}','{}',1),(2,2,'2026-01-02','{}','{}',2),(3,3,'2026-01-03','{}','{}',3)");
  let queries=0;const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>{queries++;return db.prepare(sql).all(...p) as T[];},runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p);}};
  assert.deepEqual((await readClientRevisions(tx,'a')).map(r=>r.id),[2,1]);assert.equal(queries,1);
  db.exec("INSERT INTO credit_protocol_quarantine VALUES(1,'commercial','serveur')");await assert.rejects(readClientRevisions(tx,'a'),/rapprochement/);
 }finally{db.close();}
});
