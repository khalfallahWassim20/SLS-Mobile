import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {tourCloseQueueSchema,prepareTourClose,acknowledgeTourClose,applyReopenedServerState,assertLocalTourWritable,sendPreparedTourClose} from '../../../apps/mobile/tour-close-queue.js';
const id='a1000000-0000-4000-8000-000000000001',request='a1000000-0000-4000-8000-000000000002',day='2026-11-10';
function setup() {
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE sales_outbox(operation_id TEXT); CREATE TABLE journal_sync_outbox(operation_id TEXT);
 CREATE TABLE tour_pre_invoices(id TEXT); CREATE TABLE journal_sync_state(invoice_id TEXT); CREATE TABLE sales(payload TEXT); CREATE TABLE settlements(payload TEXT); ${tourCloseQueueSchema} ${tourCloseQueueSchema}`);
 const tx={getFirstAsync:async<T>(sql:string,...params:(string|number|null)[])=>db.prepare(sql).get(...params) as T||null,runAsync:async(sql:string,...params:(string|number|null)[])=>{db.prepare(sql).run(...params);}};
 return {db,tx};
}
test('clôture locale : bloque les files et données historiques sans les effacer',async()=>{
 const {db,tx}=setup();
 try {
  for(const [table,column,value] of [['sales_outbox','operation_id','x'],['journal_sync_outbox','operation_id','x'],['sales','payload','{}'],['settlements','payload','{}'],['tour_pre_invoices','id','x']]){
   db.prepare(`INSERT INTO ${table}(${column}) VALUES(?)`).run(value);
   await assert.rejects(prepareTourClose(tx,id,day,0,()=>request),/en attente ou anciennes/);
   assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n,1);
   db.exec(`DELETE FROM ${table}`);
  }
  db.exec("INSERT INTO sales(payload) VALUES('{invalid')");
  await assert.rejects(prepareTourClose(tx,id,day,0,()=>request));
  db.exec('DELETE FROM sales');
  assert.equal((await prepareTourClose(tx,id,day,0,()=>request)).status,'closing');
  await assert.rejects(assertLocalTourWritable(tx,id,day),/attente/);
 } finally {db.close();}
});
test('reprise après réponse perdue et réouverture explicitement confirmée',async()=>{
 const {db,tx}=setup();
 try {
  const start=await prepareTourClose(tx,id,day,4,()=>request);
  assert.deepEqual({...await prepareTourClose(tx,id,day,4,()=>{throw Error('Ne doit pas générer de nouvel UUID');})},start);
  await assert.rejects(prepareTourClose(tx,id,day,5,()=>request));
  const response={status:'duplicate',requestId:request,commercialId:id,day,action:'close',version:5};
  await assert.rejects(acknowledgeTourClose(tx,id,day,{...response,requestId:'mauvais'}),/invalide/);
  await assert.rejects(acknowledgeTourClose(tx,id,day,{...response,version:6}),/invalide/);
  assert.equal(await applyReopenedServerState(tx,id,day,{commercialId:id,day,status:'open',version:6}),false);
  await acknowledgeTourClose(tx,id,day,response);
  await assert.rejects(assertLocalTourWritable(tx,id,day),/clôturée/);
  await assert.rejects(applyReopenedServerState(tx,id,day,{commercialId:id,day,status:'open',version:5}),/non confirmée/);
  await assert.rejects(applyReopenedServerState(tx,id,day,{commercialId:id,day,status:'closed',version:6}),/non confirmée/);
  assert.equal(await applyReopenedServerState(tx,id,day,{commercialId:id,day,status:'open',version:6}),true);
  await assertLocalTourWritable(tx,id,day);
 } finally {db.close();}
});

test('envoi de clôture : coupure et accusé invalide préservent la demande',async()=>{
 const {db,tx}=setup();
 try {
  const attempt=await prepareTourClose(tx,id,day,0,()=>request);
  const acknowledge=(body:unknown)=>acknowledgeTourClose(tx,id,day,body);
  await assert.rejects(sendPreparedTourClose(attempt,async()=>{throw Error('coupure');},acknowledge),/coupure/);
  await assert.rejects(sendPreparedTourClose(attempt,async()=>({ok:true,status:200,json:async()=>({status:'duplicate',requestId:'autre'})}),acknowledge),/invalide/);
  assert.equal((await prepareTourClose(tx,id,day,0,()=>{throw Error('nouvel UUID');})).requestId,request);
  let sent:unknown;
  await sendPreparedTourClose(attempt,async(body)=>{sent=body;return {ok:true,status:200,json:async()=>({status:'duplicate',requestId:request,commercialId:id,day,action:'close',version:1})};},acknowledge);
  assert.deepEqual(sent,{requestId:request,day,expectedVersion:0});
  await assert.rejects(assertLocalTourWritable(tx,id,day),/clôturée/);
 } finally {db.close();}
});
