import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {inspectCreditStartup} from '../../../apps/mobile/credit-startup-guard.js';

test('démarrage avoir : lecture cohérente, erreurs et données orphelines bloquent sans effacement',async()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`${identifiedDeviceSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}`);
  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{db.prepare(sql).run(...args)}};
  const id={commercialId:'11111111-1111-4111-8111-111111111111',serverOrigin:'http://192.168.1.2:3001'};
  assert.deepEqual(await inspectCreditStartup(tx,true),{identity:null,ready:false});
  db.prepare('INSERT INTO credit_reference_prototype_cache VALUES(1,?,?,?)').run(id.commercialId,id.serverOrigin,'{}');
  await assert.rejects(inspectCreditStartup(tx,true),/sans identité/);
  assert.deepEqual(await inspectCreditStartup(tx,false),{identity:null,ready:false});
  assert.equal(db.prepare('SELECT count(*) n FROM credit_reference_prototype_cache').get()?.n,1);
  db.exec('DELETE FROM credit_reference_prototype_cache');
  db.prepare('INSERT INTO credit_protocol_quarantine VALUES(1,?,?)').run(id.commercialId,id.serverOrigin);
  await assert.rejects(inspectCreditStartup(tx,true),/rapprochement v5/);
  db.exec('DELETE FROM credit_protocol_quarantine');
  db.prepare('INSERT INTO offline_credit_prototype VALUES(?,?,?,?,?,?,?)').run('op','inv','sale',id.commercialId,id.serverOrigin,'{}',1);
  await assert.rejects(inspectCreditStartup(tx,true),/avoirs existent/);
  assert.equal(db.prepare('SELECT count(*) n FROM offline_credit_prototype').get()?.n,1);
  db.exec('DELETE FROM offline_credit_prototype');
  db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(id.commercialId,id.serverOrigin);
  assert.deepEqual(JSON.parse(JSON.stringify(await inspectCreditStartup(tx,true))),{identity:id,ready:false});
  db.prepare('INSERT INTO credit_reference_prototype_cache VALUES(1,?,?,?)').run(id.commercialId,id.serverOrigin,'{illisible');
  await assert.rejects(inspectCreditStartup(tx,true));
  assert.equal(db.prepare('SELECT payload FROM credit_reference_prototype_cache').get()?.payload,'{illisible');
  assert.deepEqual(JSON.parse(JSON.stringify(await inspectCreditStartup(tx,false))),{identity:id,ready:false});
  await assert.rejects(inspectCreditStartup({...tx,getFirstAsync:async()=>{throw Error('stockage indisponible');}},true),/stockage indisponible/);
 }finally{db.close();}
});
