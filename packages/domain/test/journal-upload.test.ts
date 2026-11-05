import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadJournalQueue, type JournalQueueItem } from '../../../apps/mobile/journal-upload.js';
const item = (sequence:number):JournalQueueItem => ({sequence,operationId:`op-${sequence}`,invoiceId:'invoice',version:sequence,payload:JSON.stringify({operationId:`op-${sequence}`,version:sequence,invoice:{id:'invoice'}})});
const ok = (id:string,status='received') => ({ok:true,status:200,json:async()=>({status,operationId:id})});

test('coupure avant réponse et renvoi : aucun accusé perdu ni double envoi des versions suivantes',async()=>{
 const pending=[item(1),item(2)]; const received=new Set<string>(); const calls:string[]=[]; let lost=true;
 const send=async (e:JournalQueueItem)=>{
  calls.push(e.operationId); const duplicate=received.has(e.operationId); received.add(e.operationId);
  if(lost) {lost=false;throw Error('Connexion perdue après réception');}
  return ok(e.operationId,duplicate?'duplicate':'received');
 };
 const ack=async (id:string)=>{const index=pending.findIndex(e=>e.operationId===id);if(index>=0)pending.splice(index,1);};
 await assert.rejects(uploadJournalQueue([...pending],send,ack),/Connexion perdue/);
 assert.deepEqual(pending.map(e=>e.operationId),['op-1','op-2']);
 assert.equal(await uploadJournalQueue([...pending],send,ack),2);
 assert.deepEqual(calls,['op-1','op-1','op-2']);assert.equal(received.size,2);assert.equal(pending.length,0);
});

test('réponse incorrecte ou conflit : conserve la version et bloque les suivantes',async()=>{
 for (const response of [ok('autre'),ok('op-1','unknown'),{ok:true,status:200,json:async()=>{throw Error('JSON');}},{ok:false,status:409,json:async()=>({error:'Conflit de version'})}]) {
  const acked:string[]=[], calls:string[]=[];
  await assert.rejects(uploadJournalQueue([item(1),item(2)],async e=>{calls.push(e.operationId);return response;},async id=>{acked.push(id);}));
  assert.deepEqual(acked,[]);assert.deepEqual(calls,['op-1']);
 }
});

test('erreur d’accusé SQLite et ordre invalide : arrêt sans perte',async()=>{
 let sends=0;
 await assert.rejects(uploadJournalQueue([item(1),item(2)],async e=>{sends++;return ok(e.operationId);},async()=>{throw Error('SQLite');}),/SQLite/);
 assert.equal(sends,1);
 let invalidSends=0;
 await assert.rejects(uploadJournalQueue([item(2),item(1)],async e=>{invalidSends++;return ok(e.operationId);},async()=>{}),/incohérente/);
 assert.equal(invalidSends,0);
 const bad={...item(1),payload:JSON.stringify({operationId:'autre',version:1,invoice:{id:'invoice'}})};
 await assert.rejects(uploadJournalQueue([bad],async e=>ok(e.operationId),async()=>{}),/incohérents/);
});
