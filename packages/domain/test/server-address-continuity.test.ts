import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {inspectAddressContinuity} from '../../../apps/mobile/server-address-continuity.js';

test('rapprochement des références : absence, historique divergent, perte ou progression bloquent sans écriture',async()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(identifiedDeviceSchema);const tx={getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[],getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null,runAsync:async(sql:string,...args:(string|number|null)[])=>{db.prepare(sql).run(...args)}};
  const identity={commercialId:randomUUID(),serverOrigin:'http://192.168.43.101:3001'},client=randomUUID(),sale=randomUUID(),invoice=randomUUID(),payment=randomUUID();
  db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);
  const reference={version:4,clients:[{id:client,name:'Test',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'0'}],articles:[],saleStates:[{saleId:sale,clientId:client,version:1,total:'1000',paid:'500'}],settlementStates:[{operationId:payment,clientId:client}],journalStates:[{id:invoice,clientId:client,journalDate:'2026-11-10',total:1000,receipts:[]}],journalProofs:[{id:invoice,version:1,hash:'a'.repeat(64)}]};
  const digest=async(s:string)=>createHash('sha256').update(s).digest('hex');
  await assert.rejects(inspectAddressContinuity(tx,identity,4,reference,digest),/indisponible/);
  const payload=JSON.stringify(reference);db.prepare('INSERT INTO identified_reference_cache VALUES(1,?,?,?)').run(identity.commercialId,identity.serverOrigin,payload);
  assert.deepEqual(await inspectAddressContinuity(tx,identity,4,reference,digest),{anchors:3,version:4});
  await assert.rejects(inspectAddressContinuity(tx,identity,4,{...reference,saleStates:[]},digest),/vente/);
  await assert.rejects(inspectAddressContinuity(tx,identity,4,{...reference,saleStates:[{...reference.saleStates[0],version:2}]},digest),/vente/);
  await assert.rejects(inspectAddressContinuity(tx,identity,4,{...reference,settlementStates:[]},digest),/règlement/);
  await assert.rejects(inspectAddressContinuity(tx,identity,4,{...reference,journalProofs:[{...reference.journalProofs[0],hash:'b'.repeat(64)}]},digest),/Preuve/);
  assert.equal(db.prepare('SELECT payload FROM identified_reference_cache').get()?.payload,payload);
  const empty={...reference,saleStates:[],settlementStates:[],journalStates:[],journalProofs:[]};db.prepare('UPDATE identified_reference_cache SET payload=?').run(JSON.stringify(empty));
  await assert.rejects(inspectAddressContinuity(tx,identity,4,empty,digest),/Aucune opération/);
 }finally{db.close();}
});
