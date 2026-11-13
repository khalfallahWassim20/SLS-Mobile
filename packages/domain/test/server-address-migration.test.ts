import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {creditSourcesPrototypeSchema} from '../../../apps/mobile/credit-note-sources-prototype.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {remoteSaleDraftPrototypeSchema,remoteSaleConfirmPrototypeSchema} from '../../../apps/mobile/credit-remote-sale-schema-prototype.js';
import {migrateDeviceOriginPrototype} from '../../../apps/mobile/server-address-migration.js';

function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(`${identifiedDeviceSchema}${creditReferencePrototypeSchema}${creditSourcesPrototypeSchema}${offlineCreditPrototypeSchema}${remoteSaleDraftPrototypeSchema}${remoteSaleConfirmPrototypeSchema} CREATE TABLE sales_outbox(operation_id TEXT,payload TEXT);CREATE TABLE sales(id INTEGER,payload TEXT);`);
 const tx={getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[],getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null,runAsync:async(sql:string,...args:(string|number|null)[])=>{db.prepare(sql).run(...args)}};
 const old={commercialId:randomUUID(),serverOrigin:'http://192.168.43.101:3001'},target='http://192.168.100.23:3001';
 db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(old.commercialId,old.serverOrigin);
 db.prepare('INSERT INTO identified_reference_cache VALUES(1,?,?,?)').run(old.commercialId,old.serverOrigin,'{"keep":true}');
 db.prepare('INSERT INTO credit_protocol_quarantine VALUES(1,?,?)').run(old.commercialId,old.serverOrigin);
 db.prepare('INSERT INTO sales_outbox VALUES(?,?)').run('pending','{"money":123}');db.prepare('INSERT INTO sales VALUES(1,?)').run('{"sale":true}');
 return {db,tx,old,target};
}
test('migration isolée : préserve files, historique et cache, et reste annulable',async()=>{
 const {db,tx,old,target}=fixture();try{
  db.exec('BEGIN');await migrateDeviceOriginPrototype(tx,old,target);
  assert.equal(db.prepare('SELECT server_origin FROM identified_device').get()?.server_origin,target);
  assert.equal(db.prepare('SELECT server_origin FROM identified_reference_cache').get()?.server_origin,target);
  assert.equal(db.prepare('SELECT server_origin FROM credit_protocol_quarantine').get()?.server_origin,target);
  assert.equal(db.prepare('SELECT payload FROM sales_outbox').get()?.payload,'{"money":123}');
  assert.equal(db.prepare('SELECT payload FROM sales').get()?.payload,'{"sale":true}');
  db.exec('ROLLBACK');assert.equal(db.prepare('SELECT server_origin FROM identified_device').get()?.server_origin,old.serverOrigin);
 }finally{db.close();}
});
test('migration isolée : identité, tables inconnues et historique v5 bloquent sans perte',async()=>{
 const {db,tx,old,target}=fixture();try{
  await assert.rejects(migrateDeviceOriginPrototype(tx,{...old,commercialId:randomUUID()},target),/Liaison/);
  db.exec('CREATE TABLE future(server_origin TEXT)');await assert.rejects(migrateDeviceOriginPrototype(tx,old,target),/Nouvelle table/);db.exec('DROP TABLE future');
  db.prepare('INSERT INTO offline_credit_prototype VALUES(?,?,?,?,?,?,?)').run(randomUUID(),randomUUID(),'sale',old.commercialId,old.serverOrigin,'{}',1);
  await assert.rejects(migrateDeviceOriginPrototype(tx,old,target),/Historique/);
  assert.equal(db.prepare('SELECT server_origin FROM identified_reference_cache').get()?.server_origin,old.serverOrigin);
  assert.equal(db.prepare('SELECT count(*) AS n FROM offline_credit_prototype').get()?.n,1);
  assert.equal(db.prepare('SELECT payload FROM sales_outbox').get()?.payload,'{"money":123}');
 }finally{db.close();}
});
test('migration isolée : erreur au milieu des écritures restaure tout',async()=>{
 const {db,tx,old,target}=fixture();try{
  db.exec("CREATE TRIGGER deny_address BEFORE UPDATE ON identified_device BEGIN SELECT RAISE(ABORT,'test rollback'); END");
  await assert.rejects(migrateDeviceOriginPrototype(tx,old,target),/test rollback/);
  assert.equal(db.prepare('SELECT server_origin FROM identified_device').get()?.server_origin,old.serverOrigin);
  assert.equal(db.prepare('SELECT server_origin FROM identified_reference_cache').get()?.server_origin,old.serverOrigin);
  assert.equal(db.prepare('SELECT server_origin FROM credit_protocol_quarantine').get()?.server_origin,old.serverOrigin);
 }finally{db.close();}
});
