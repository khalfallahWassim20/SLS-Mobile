import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema} from '../../../apps/mobile/tour-close-queue.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {tourExpenseSchema,addTourExpense,readTourExpenses,readOriginalExpenses,readExpenseRevisions,readExpenseCancellations,reviseTourExpense,cancelTourExpense,acknowledgeTourExpense,acknowledgeExpenseRevision,acknowledgeExpenseCancellation} from '../../../apps/mobile/tour-expenses.js';
import {reconcileExpenseSnapshot} from '../../../apps/mobile/tour-expense-snapshot.js';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {storeTourExpense} from '../../../apps/api/src/tour-expenses.js';
import {storeExpenseRevision} from '../../../apps/api/src/tour-expense-revisions.js';
import {storeExpenseCancellation} from '../../../apps/api/src/tour-expense-cancellations.js';
import {readExpenseSnapshot} from '../../../apps/api/src/tour-expense-snapshot.js';

function phone(id:{commercialId:string;serverOrigin:string}){
 const db=new DatabaseSync(':memory:');db.exec(`${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}${tourExpenseSchema}`);db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(id.commercialId,id.serverOrigin);
 const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};
 return {db,tx,async importSnapshot(snapshot:unknown){db.exec('BEGIN');try{const n=await reconcileExpenseSnapshot(tx,id,'2026-11-08',snapshot);db.exec('COMMIT');return n;}catch(e){db.exec('ROLLBACK');throw e;}}};
}
test('deux téléphones : actualisation additive, corrections, annulation et refus sans perte des divergences',async()=>{
 const db=new PGlite();let a:ReturnType<typeof phone>|undefined,b:ReturnType<typeof phone>|undefined;
 try{
  await db.exec(schemaSql);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const conn={query:(sql:string,args?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,args),release:()=>{}};const pool={connect:async()=>conn,query:conn.query} as unknown as Pool;
  const commercial=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});await setCommercialCredentials(pool,'admin',commercial.id,{login:'cross.expense',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour les tests',session=await loginCommercial(pool,secret,{login:'cross.expense',password:'mot de passe fictif'});assert.ok(session);
  const id={commercialId:commercial.id,serverOrigin:'http://192.168.1.2:3001'},credentials={token:session.token,secret,enforceMode:true};a=phone(id);b=phone(id);
  await assert.rejects(readExpenseSnapshot(pool,'2026-11-08',{...credentials,token:'invalid'}),/Session invalide/);
  const first={operationId:randomUUID(),createdAt:'2026-11-08T09:00:00.000Z',description:'Carburant',amount:10000};await addTourExpense(a.tx,id,first);
  await storeTourExpense(pool,first,credentials);await acknowledgeTourExpense(a.tx,id,(await readOriginalExpenses(a.tx,id))[0],{status:'received',operationId:first.operationId});
  let snapshot=await readExpenseSnapshot(pool,'2026-11-08',credentials);assert.equal(await b.importSnapshot(snapshot),1);assert.equal((await readTourExpenses(b.tx,id))[0].amount,10000);
  const third=phone(id);try{
   const second={operationId:randomUUID(),createdAt:'2026-11-08T09:30:00.000Z',description:'Frais',amount:900};await storeTourExpense(pool,second,credentials);
   const two=await readExpenseSnapshot(pool,'2026-11-08',credentials);let writes=0;const faulty={...third.tx,runAsync:async(sql:string,...params:(string|number|null)[])=>{if(++writes===2)throw Error('panne simulée');return third.tx.runAsync(sql,...params);}};
   third.db.exec('BEGIN');try{await assert.rejects(reconcileExpenseSnapshot(faulty,id,'2026-11-08',two),/panne simulée/);third.db.exec('ROLLBACK');}catch(e){third.db.exec('ROLLBACK');throw e;}
   assert.equal((await readTourExpenses(third.tx,id)).length,0);
  }finally{third.db.close();}
  let [current]=await readTourExpenses(b.tx,id);await reviseTourExpense(b.tx,id,current,{operationId:randomUUID(),recordedAt:'2026-11-08T10:00:00.000Z',description:'Carburant corrigé',amount:12000});
  const [rev]=await readExpenseRevisions(b.tx,id),{commercialId:_c,serverOrigin:_o,pending:_p,...payload}=rev;
  await storeExpenseRevision(pool,payload,credentials);await acknowledgeExpenseRevision(b.tx,id,rev,{status:'received',operationId:rev.operationId});
  snapshot=await readExpenseSnapshot(pool,'2026-11-08',credentials);await a.importSnapshot(snapshot);current=(await readTourExpenses(a.tx,id))[0];assert.equal(current.amount,12000);assert.equal(current.version,2);
  await cancelTourExpense(a.tx,id,current,{operationId:randomUUID(),recordedAt:'2026-11-08T11:00:00.000Z',reason:'Doublon'});
  const [cancel]=await readExpenseCancellations(a.tx,id),{commercialId:_cc,serverOrigin:_oo,pending:_pp,...cancelPayload}=cancel;
  await assert.rejects(a.importSnapshot(snapshot),/Synchronisez/);assert.equal((await readTourExpenses(a.tx,id))[0].cancelled,true);
  await storeExpenseCancellation(pool,cancelPayload,credentials);await acknowledgeExpenseCancellation(a.tx,id,cancel,{status:'received',operationId:cancel.operationId});
  snapshot=await readExpenseSnapshot(pool,'2026-11-08',credentials);await b.importSnapshot(snapshot);assert.equal((await readTourExpenses(b.tx,id))[0].cancelled,true);assert.equal((await readExpenseCancellations(b.tx,id))[0].reason,'Doublon');
  const before=JSON.stringify(await readTourExpenses(b.tx,id));await assert.rejects(b.importSnapshot({...snapshot,expenses:[]}),/absente/);assert.equal(JSON.stringify(await readTourExpenses(b.tx,id)),before);
  await assert.rejects(b.importSnapshot({...snapshot,commercialId:randomUUID()}),/invalide/);assert.equal(JSON.stringify(await readTourExpenses(b.tx,id)),before);
  const broken=structuredClone(snapshot);broken.expenses[0].revisions[0].previousAmount=999;await assert.rejects(b.importSnapshot(broken),/invalide/);assert.equal(JSON.stringify(await readTourExpenses(b.tx,id)),before);
  await assert.rejects(b.importSnapshot({...snapshot,expenses:[...snapshot.expenses,...snapshot.expenses]}),/invalide/);
 }finally{a?.db.close();b?.db.close();await db.close();}
});

test('deux téléphones hors ligne : versions concurrentes refusées sans effacer la correction locale',async()=>{
 const db=new PGlite();let a:ReturnType<typeof phone>|undefined,b:ReturnType<typeof phone>|undefined;
 try{
  await db.exec(schemaSql);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const conn={query:(sql:string,args?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,args),release:()=>{}};const pool={connect:async()=>conn,query:conn.query} as unknown as Pool;
  const commercial=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});await setCommercialCredentials(pool,'admin',commercial.id,{login:'conflict.expense',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour les tests',session=await loginCommercial(pool,secret,{login:'conflict.expense',password:'mot de passe fictif'});assert.ok(session);
  const id={commercialId:commercial.id,serverOrigin:'http://192.168.1.2:3001'},credentials={token:session.token,secret,enforceMode:true};a=phone(id);b=phone(id);
  const original={operationId:randomUUID(),createdAt:'2026-11-08T09:00:00.000Z',description:'Carburant',amount:10000};
  await addTourExpense(a.tx,id,original);assert.equal(await storeTourExpense(pool,original,credentials),'received');
  // Réponse perdue : reprise du même identifiant puis acquittement local.
  assert.equal(await storeTourExpense(pool,original,credentials),'duplicate');
  await acknowledgeTourExpense(a.tx,id,(await readOriginalExpenses(a.tx,id))[0],{status:'duplicate',operationId:original.operationId});
  await b.importSnapshot(await readExpenseSnapshot(pool,'2026-11-08',credentials));
  await reviseTourExpense(a.tx,id,(await readTourExpenses(a.tx,id))[0],{operationId:randomUUID(),recordedAt:'2026-11-08T10:00:00.000Z',description:'Carburant A',amount:11000});
  await reviseTourExpense(b.tx,id,(await readTourExpenses(b.tx,id))[0],{operationId:randomUUID(),recordedAt:'2026-11-08T10:01:00.000Z',description:'Carburant B',amount:12000});
  const [revisionA]=await readExpenseRevisions(a.tx,id),[revisionB]=await readExpenseRevisions(b.tx,id);
  const payload=(r:typeof revisionA)=>({operationId:r.operationId,expenseId:r.expenseId,version:r.version,recordedAt:r.recordedAt,previousDescription:r.previousDescription,previousAmount:r.previousAmount,description:r.description,amount:r.amount});
  assert.equal(await storeExpenseRevision(pool,payload(revisionA),credentials),'received');
  assert.equal(await storeExpenseRevision(pool,payload(revisionA),credentials),'duplicate');
  await acknowledgeExpenseRevision(a.tx,id,revisionA,{status:'duplicate',operationId:revisionA.operationId});
  const before=JSON.stringify(await readTourExpenses(b.tx,id));
  await assert.rejects(storeExpenseRevision(pool,payload(revisionB),credentials),/rapprochement nécessaire/);
  await assert.rejects(b.importSnapshot(await readExpenseSnapshot(pool,'2026-11-08',credentials)),/Synchronisez/);
  assert.equal(JSON.stringify(await readTourExpenses(b.tx,id)),before);
  assert.equal((await readExpenseRevisions(b.tx,id))[0].pending,1);
  const snapshot=await readExpenseSnapshot(pool,'2026-11-08',credentials);
  assert.equal(snapshot.expenses[0].revisions.length,1);assert.equal(snapshot.expenses[0].revisions[0].operationId,revisionA.operationId);
 }finally{a?.db.close();b?.db.close();await db.close();}
});

test('instantané volumineux : historiques ordonnés, annulations, reprise et refus atomique',async()=>{
 const id={commercialId:randomUUID(),serverOrigin:'http://192.168.1.2:3001'},p=phone(id);
 try{
  const expenses=Array.from({length:1000},(_,i)=>({operationId:randomUUID(),createdAt:'2026-11-08T09:00:00.000Z',description:`Dépense ${i}`,amount:1000+i,
   revisions:[{operationId:randomUUID(),version:2,recordedAt:'2026-11-08T10:00:00.000Z',previousDescription:`Dépense ${i}`,previousAmount:1000+i,description:`Corrigée ${i}`,amount:2000+i},{operationId:randomUUID(),version:3,recordedAt:'2026-11-08T11:00:00.000Z',previousDescription:`Corrigée ${i}`,previousAmount:2000+i,description:`Finale ${i}`,amount:3000+i}],
   cancellation:i%2===0?{operationId:randomUUID(),version:3,recordedAt:'2026-11-08T12:00:00.000Z',description:`Finale ${i}`,amount:3000+i,reason:'Doublon'}:null}));
  const snapshot={version:1,commercialId:id.commercialId,day:'2026-11-08',expenses};
  assert.equal(await p.importSnapshot(snapshot),1000);assert.equal(await p.importSnapshot(snapshot),1000);
  const rows=await readTourExpenses(p.tx,id),revisions=await readExpenseRevisions(p.tx,id),cancellations=await readExpenseCancellations(p.tx,id);
  assert.equal(rows.length,1000);assert.equal(revisions.length,2000);assert.equal(cancellations.length,500);
  for(let i=0;i<1000;i++){const row=rows.find(x=>x.operationId===expenses[i].operationId);assert.ok(row);assert.equal(row.version,3);assert.equal(row.amount,3000+i);assert.equal(Boolean(row.cancelled),i%2===0);assert.equal(row.pending,0);}
  const bad=structuredClone(snapshot);bad.expenses[999].revisions[1].previousAmount=1;
  await assert.rejects(p.importSnapshot(bad),/Historique distant invalide/);
  assert.deepEqual(await readTourExpenses(p.tx,id),rows);
 }finally{p.db.close();}
});
