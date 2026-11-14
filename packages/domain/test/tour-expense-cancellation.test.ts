import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema} from '../../../apps/mobile/tour-close-queue.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {tourExpenseSchema,addTourExpense,readTourExpenses,readOriginalExpenses,readExpenseRevisions,readExpenseCancellations,reviseTourExpense,cancelTourExpense,acknowledgeTourExpense,acknowledgeExpenseRevision,acknowledgeExpenseCancellation} from '../../../apps/mobile/tour-expenses.js';

test('annulation hors ligne : ordre des accusés, motif, historique et clôture',async()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(`${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}${tourExpenseSchema}`);
  const id={commercialId:randomUUID(),serverOrigin:'http://192.168.1.2:3001'};db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(id.commercialId,id.serverOrigin);
  const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};
  await addTourExpense(tx,id,{operationId:randomUUID(),createdAt:'2026-11-08T09:00:00.000Z',description:'Frais',amount:10000});
  let [current]=await readTourExpenses(tx,id);await reviseTourExpense(tx,id,current,{operationId:randomUUID(),recordedAt:'2026-11-08T10:00:00.000Z',description:'Frais route',amount:12000});
  [current]=await readTourExpenses(tx,id);
  const cmd={operationId:randomUUID(),recordedAt:'2026-11-08T11:00:00.000Z',reason:'Doublon'};
  await assert.rejects(cancelTourExpense(tx,id,current,{...cmd,reason:'  '}),/invalide/);await cancelTourExpense(tx,id,current,cmd);
  const [original]=await readOriginalExpenses(tx,id),[revision]=await readExpenseRevisions(tx,id),[cancellation]=await readExpenseCancellations(tx,id);
  assert.equal((await readTourExpenses(tx,id))[0].cancelled,true);
  await assert.rejects(acknowledgeExpenseCancellation(tx,id,cancellation,{status:'received',operationId:cancellation.operationId}),/hors ordre/);
  await assert.rejects(acknowledgeExpenseRevision(tx,id,revision,{status:'received',operationId:revision.operationId}),/hors ordre/);
  assert.equal((await readExpenseCancellations(tx,id))[0].pending,1);
  await acknowledgeTourExpense(tx,id,original,{status:'received',operationId:original.operationId});
  await acknowledgeExpenseRevision(tx,id,revision,{status:'received',operationId:revision.operationId});
  await acknowledgeExpenseCancellation(tx,id,cancellation,{status:'duplicate',operationId:cancellation.operationId});
  [current]=await readTourExpenses(tx,id);assert.equal(current.pending,0);assert.equal(current.cancelled,true);assert.equal(db.prepare('SELECT amount FROM tour_expenses').get()?.amount,10000);
  await assert.rejects(cancelTourExpense(tx,id,current,{...cmd,operationId:randomUUID()}),/déjà annulée/);
 }finally{db.close();}
});
