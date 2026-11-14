import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema,observeVerifiedTourState} from '../../../apps/mobile/tour-close-queue.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {tourExpenseSchema,addTourExpense,readTourExpenses,readOriginalExpenses,readExpenseRevisions,reviseTourExpense,acknowledgeTourExpense,acknowledgeExpenseRevision} from '../../../apps/mobile/tour-expenses.js';

test('plusieurs corrections hors ligne restent ordonnées et reprises sans effacer l’original',async()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(`${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}${tourExpenseSchema}`);
  const id={commercialId:randomUUID(),serverOrigin:'http://192.168.1.2:3001'};db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(id.commercialId,id.serverOrigin);
  const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};
  await addTourExpense(tx,id,{operationId:randomUUID(),createdAt:'2026-11-08T09:00:00.000Z',description:'Carburant',amount:10000});
  let [current]=await readTourExpenses(tx,id);await reviseTourExpense(tx,id,current,{operationId:randomUUID(),recordedAt:'2026-11-08T10:00:00.000Z',description:'Frais',amount:12000});
  [current]=await readTourExpenses(tx,id);await reviseTourExpense(tx,id,current,{operationId:randomUUID(),recordedAt:'2026-11-08T11:00:00.000Z',description:'Frais route',amount:15000});
  const [original]=await readOriginalExpenses(tx,id),revisions=await readExpenseRevisions(tx,id);assert.deepEqual(revisions.map(x=>x.version),[2,3]);
  assert.equal((await readTourExpenses(tx,id))[0].amount,15000);assert.equal(original.amount,10000);
  db.prepare('UPDATE tour_expense_revisions SET pending=0 WHERE version=3').run();await assert.rejects(readTourExpenses(tx,id),/incohérent/);db.prepare('UPDATE tour_expense_revisions SET pending=1 WHERE version=3').run();
  await acknowledgeTourExpense(tx,id,original,{status:'duplicate',operationId:original.operationId});
  await acknowledgeExpenseRevision(tx,id,revisions[0],{status:'received',operationId:revisions[0].operationId});
  await acknowledgeExpenseRevision(tx,id,revisions[1],{status:'duplicate',operationId:revisions[1].operationId});
  [current]=await readTourExpenses(tx,id);assert.equal(current.pending,0);assert.equal(current.version,3);assert.equal(current.amount,15000);
  assert.equal(db.prepare('SELECT amount FROM tour_expenses').get()?.amount,10000);assert.equal(db.prepare('SELECT count(*) n FROM tour_expense_revisions').get()?.n,2);
  db.prepare("INSERT INTO tour_known_server_states VALUES(?,?,?,?)").run(id.commercialId,'2026-11-08','closed',1);
  await assert.rejects(reviseTourExpense(tx,id,current,{operationId:randomUUID(),recordedAt:'2026-11-08T12:00:00.000Z',description:'Nouvelle correction',amount:16000}),/clôturée/);
  db.prepare('INSERT INTO tour_close_attempts VALUES(?,?,?,?,?,?)').run(id.commercialId,'2026-11-08',randomUUID(),0,'closed',1);
  await assert.rejects(observeVerifiedTourState(tx,id.commercialId,'2026-11-08',{commercialId:id.commercialId,day:'2026-11-08',status:'open',version:1}),/incohérent/);
  await observeVerifiedTourState(tx,id.commercialId,'2026-11-08',{commercialId:id.commercialId,day:'2026-11-08',status:'open',version:2});
  await reviseTourExpense(tx,id,current,{operationId:randomUUID(),recordedAt:'2026-11-09T12:00:00.000Z',description:'Nouvelle correction',amount:16000});
  [current]=await readTourExpenses(tx,id);assert.equal(current.day,'2026-11-08');assert.equal(current.version,4);assert.equal(current.pending,1);
  db.prepare('INSERT INTO tour_known_server_states VALUES(?,?,?,?)').run(id.commercialId,'2026-11-09','closed',1);
  await assert.rejects(reviseTourExpense(tx,id,current,{operationId:randomUUID(),recordedAt:'2026-11-09T13:00:00.000Z',description:'Encore',amount:17000}),/clôturée/);
 }finally{db.close();}
});
