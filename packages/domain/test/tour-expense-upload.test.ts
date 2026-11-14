import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uploadTourExpenses} from '../../../apps/mobile/tour-expense-upload.js';
import {ClosedDaySyncError} from '../../../apps/mobile/identified-upload.js';
import type {TourExpense,ExpenseRevision,ExpenseCancellation} from '../../../apps/mobile/tour-expenses.js';
const id={commercialId:'a1000000-0000-4000-8000-000000000001',serverOrigin:'http://192.168.1.2:3001'};
const original:TourExpense={...id,operationId:'a1000000-0000-4000-8000-000000000002',day:'2026-11-08',createdAt:'2026-11-08T09:00:00.000Z',description:'Frais',amount:1000,pending:1};
const revision:ExpenseRevision={...id,operationId:'a1000000-0000-4000-8000-000000000003',expenseId:original.operationId,version:2,recordedAt:'2026-11-08T10:00:00.000Z',previousDescription:'Frais',previousAmount:1000,description:'Frais corrigés',amount:1200,pending:1};
const cancellation:ExpenseCancellation={...id,operationId:'a1000000-0000-4000-8000-000000000004',expenseId:original.operationId,version:2,recordedAt:'2026-11-08T11:00:00.000Z',description:'Frais corrigés',amount:1200,reason:'Doublon',pending:1};
const pending={originals:[original],revisions:[revision],cancellations:[cancellation]};
test('dépenses : envoi ordonné, réponse perdue et reprise partielle',async()=>{
 const acknowledgements:string[]=[],sent:string[]=[];
 const confirm={original:async(e:TourExpense,r:unknown)=>{assert.deepEqual(r,{status:'duplicate',operationId:e.operationId});acknowledgements.push(e.operationId);},revision:async(e:ExpenseRevision)=>{acknowledgements.push(e.operationId);},cancellation:async(e:ExpenseCancellation)=>{acknowledgements.push(e.operationId);}};
 await assert.rejects(uploadTourExpenses(pending,id,async(path,payload)=>{sent.push(path);if(path==='expense-revisions')throw Error('coupure');return {ok:true,status:200,json:async()=>({status:'duplicate',operationId:(payload as {operationId:string}).operationId})};},confirm),/coupure/);
 assert.deepEqual(sent,['expenses','expense-revisions']);assert.deepEqual(acknowledgements,[original.operationId]);
 const resumed={...pending,originals:[]};
 assert.equal(await uploadTourExpenses(resumed,id,async(path,payload)=>{sent.push(path);return {ok:true,status:200,json:async()=>({status:'received',operationId:(payload as {operationId:string}).operationId})};},confirm),2);
 assert.deepEqual(acknowledgements,[original.operationId,revision.operationId,cancellation.operationId]);
});
test('dépenses : identité, conflit, clôture valide ou malformée et accusé refusé',async()=>{
 let sends=0,acks=0;const confirm={original:async()=>{acks++;throw Error('Accusé invalide');},revision:async()=>{acks++;},cancellation:async()=>{acks++;}};
 const ok=async()=>{sends++;return {ok:true,status:200,json:async()=>({status:'received'})};};
 await assert.rejects(uploadTourExpenses({...pending,revisions:[{...revision,serverOrigin:'http://other'}]},id,ok,confirm),/incohérente/);assert.equal(sends,0);
 await assert.rejects(uploadTourExpenses({...pending,revisions:[{...revision,operationId:original.operationId}]},id,ok,confirm),/incohérente/);assert.equal(sends,0);
 await assert.rejects(uploadTourExpenses(pending,id,ok,confirm),/Accusé invalide/);assert.equal(sends,1);assert.equal(acks,1);
 const reject=(day:string,commercialId:string)=>async()=>({ok:false,status:409,json:async()=>({code:'TOUR_DAY_CLOSED',day,commercialId,error:'Conflit serveur'})});
 await assert.rejects(uploadTourExpenses(pending,id,reject('2026-11-08',id.commercialId),confirm),e=>e instanceof ClosedDaySyncError&&e.day==='2026-11-08');
 await assert.rejects(uploadTourExpenses(pending,id,reject('2026-02-30',id.commercialId),confirm),e=>e instanceof Error&&!(e instanceof ClosedDaySyncError)&&e.message==='Conflit serveur');
 await assert.rejects(uploadTourExpenses(pending,id,reject('2026-11-08','invalide'),confirm),e=>e instanceof Error&&!(e instanceof ClosedDaySyncError));
 assert.equal(acks,1);
});

test('file SQLite : accusé corrompu et panne après réception préservent les écritures',async()=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {identifiedDeviceSchema}=await import('../../../apps/mobile/identified-device.js');
 const {tourCloseQueueSchema}=await import('../../../apps/mobile/tour-close-queue.js');
 const {offlineCreditPrototypeSchema}=await import('../../../apps/mobile/credit-note-offline-prototype.js');
 const {creditReferencePrototypeSchema}=await import('../../../apps/mobile/credit-note-reference-cache-prototype.js');
 const mobile=await import('../../../apps/mobile/tour-expenses.js');
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}${mobile.tourExpenseSchema}`);db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(id.commercialId,id.serverOrigin);
  const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};
  await mobile.addTourExpense(tx,id,original);const [state]=await mobile.readTourExpenses(tx,id);
  await mobile.reviseTourExpense(tx,id,state,revision);
  const read=async()=>({originals:(await mobile.readOriginalExpenses(tx,id)).filter(x=>x.pending===1),revisions:(await mobile.readExpenseRevisions(tx,id)).filter(x=>x.pending===1),cancellations:(await mobile.readExpenseCancellations(tx,id)).filter(x=>x.pending===1)});
  const confirm={original:(e:TourExpense,r:unknown)=>mobile.acknowledgeTourExpense(tx,id,e,r),revision:(e:ExpenseRevision,r:unknown)=>mobile.acknowledgeExpenseRevision(tx,id,e,r),cancellation:(e:ExpenseCancellation,r:unknown)=>mobile.acknowledgeExpenseCancellation(tx,id,e,r)};
  await assert.rejects(uploadTourExpenses(await read(),id,async()=>({ok:true,status:200,json:async()=>({status:'received',operationId:revision.operationId})}),confirm),/invalide/);
  assert.equal((await read()).originals.length,1);assert.equal((await read()).revisions.length,1);
  await assert.rejects(uploadTourExpenses(await read(),id,async(path,payload)=>{if(path==='expense-revisions')throw Error('réponse perdue');return {ok:true,status:200,json:async()=>({status:'received',operationId:(payload as {operationId:string}).operationId})};},confirm),/réponse perdue/);
  assert.equal((await read()).originals.length,0);assert.equal((await read()).revisions.length,1);
  assert.equal(await uploadTourExpenses(await read(),id,async(_path,payload)=>({ok:true,status:200,json:async()=>({status:'duplicate',operationId:(payload as {operationId:string}).operationId})}),confirm),1);
  assert.equal((await mobile.readTourExpenses(tx,id))[0].pending,0);assert.equal((await mobile.readExpenseRevisions(tx,id))[0].operationId,revision.operationId);
 }finally{db.close();}
});
