import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {uploadDemoQueue,acknowledgeDemoQueueEntry,type DemoQueueEntry} from '../../../apps/mobile/demo-upload.js';
const saleId='a1000000-0000-4000-8000-000000000001',op='a1000000-0000-4000-8000-000000000002',pay='a1000000-0000-4000-8000-000000000003';
const sale:DemoQueueEntry={sequence:1,operationId:op,saleId,version:1,payload:JSON.stringify({operationId:op,saleId,version:1,sale:{syncSaleId:saleId,syncVersion:1},refund:0}),lastError:null};
const settlement:DemoQueueEntry={sequence:2,operationId:pay,saleId:pay,version:1,payload:JSON.stringify({operationId:pay,settlement:{syncOperationId:pay}}),lastError:null};
test('démo : validation complète avant envoi et accusés exacts obligatoires',async()=>{
 let sent=0,acked=0;const send=async()=>{sent++;return {ok:true,status:201,json:async()=>({status:'reçue',operationId:op})}},ack=async()=>{acked++};
 await assert.rejects(uploadDemoQueue([sale,{...settlement,payload:'{'}],send,ack),/illisible/);assert.equal(sent,0);
 for(const bad of [null,{status:'reçue'},{status:'reçue',operationId:pay},{status:'ok',operationId:op}])await assert.rejects(uploadDemoQueue([sale],async()=>({ok:true,status:200,json:async()=>bad}),ack),/Accusé/);
 assert.equal(acked,0);
 await assert.rejects(uploadDemoQueue([sale],async()=>{throw Error('coupure');},ack),/coupure/);assert.equal(acked,0);
 assert.equal(await uploadDemoQueue([sale],async()=>({ok:true,status:200,json:async()=>({status:'déjà reçue',operationId:op})}),ack),1);assert.equal(acked,1);
});
test('démo : reprises partielles et ordre vente / règlement',async()=>{
 const paths:string[]=[],acks:string[]=[];
 await assert.rejects(uploadDemoQueue([sale,settlement],async(path,e)=>{paths.push(path);if(path==='settlements')throw Error('coupure');return {ok:true,status:201,json:async()=>({status:'reçue',operationId:e.operationId})};},async e=>{acks.push(e.operationId)}),/coupure/);
 assert.deepEqual(paths,['sales','settlements']);assert.deepEqual(acks,[op]);
 assert.equal(await uploadDemoQueue([settlement],async(path,e)=>({ok:true,status:200,json:async()=>({status:'déjà reçue',operationId:e.operationId})}),async e=>{acks.push(e.operationId)}),1);
 assert.deepEqual(acks,[op,pay]);
});
test('démo SQLite : toute modification de la file interdit son acquittement',async()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT,last_error TEXT)');
  db.prepare('INSERT INTO sales_outbox VALUES(?,?,?,?,?,?)').run(sale.sequence,sale.operationId,sale.saleId,sale.version,sale.payload,null);
  const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};
  db.prepare('UPDATE sales_outbox SET payload=? WHERE operation_id=?').run('{}',sale.operationId);
  await assert.rejects(acknowledgeDemoQueueEntry(tx,sale),/modifiée/);assert.equal(db.prepare('SELECT count(*) AS n FROM sales_outbox').get()?.n,1);
  db.prepare('UPDATE sales_outbox SET payload=? WHERE operation_id=?').run(sale.payload,sale.operationId);
  db.exec('BEGIN');await acknowledgeDemoQueueEntry(tx,sale);db.exec('ROLLBACK');assert.equal(db.prepare('SELECT count(*) AS n FROM sales_outbox').get()?.n,1);
  await acknowledgeDemoQueueEntry(tx,sale);assert.equal(db.prepare('SELECT count(*) AS n FROM sales_outbox').get()?.n,0);
 }finally{db.close();}
});
