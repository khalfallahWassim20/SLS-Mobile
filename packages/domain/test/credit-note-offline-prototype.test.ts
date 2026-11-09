import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema} from '../../../apps/mobile/tour-close-queue.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {offlineCreditPrototypeSchema,prepareOfflineCreditPrototype,readReadyOfflineCreditPrototype,readAllOfflineCreditPrototype,acknowledgeOfflineCreditPrototype} from '../../../apps/mobile/credit-note-offline-prototype.js';

test('avoir mobile isolé : file persistante, dépendances, identité, clôture et accusé',async()=>{
 const db=new DatabaseSync(':memory:');
 try {
  db.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,payload TEXT);CREATE TABLE sales_outbox(operation_id TEXT,sale_id TEXT,payload TEXT);
   CREATE TABLE journal_sync_outbox(operation_id TEXT,invoice_id TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(pre_invoice_id TEXT,payload TEXT);
   ${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}`);
  const tx={getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[],getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null,runAsync:async(sql:string,...args:(string|number|null)[])=>{db.prepare(sql).run(...args)}};
  const identity={commercialId:randomUUID(),serverOrigin:'https://example.test'},id=randomUUID(),operationId=randomUUID();
  db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);
  const sale={createdAt:'2026-11-08T09:00:00.000Z',syncSaleId:id,syncVersion:1,total:600000,paid:200000};
  db.prepare('INSERT INTO sales VALUES(1,?)').run(JSON.stringify(sale));
  const saleOp=randomUUID();
  db.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(saleOp,identity.commercialId,'sale',id,sale.createdAt);
  db.prepare('INSERT INTO sales_outbox VALUES(?,?,?)').run(saleOp,id,'{}');
  const cmd={operationId,invoiceId:id,expectedVersion:1,recordedAt:'2026-11-08T10:00:00.000Z',choice:'credit' as const};
  await assert.rejects(prepareOfflineCreditPrototype(tx,{...identity,serverOrigin:'https://other.test'},'sale',cmd),/identité/i);
  await assert.rejects(prepareOfflineCreditPrototype(tx,identity,'sale',{...cmd,expectedVersion:2}),/Version/);
  db.prepare("INSERT INTO tour_known_server_states VALUES(?,?,'closed',1)").run(identity.commercialId,'2026-11-08');
  await assert.rejects(prepareOfflineCreditPrototype(tx,identity,'sale',cmd),/clôturée/);
  db.prepare('DELETE FROM tour_known_server_states').run();
  db.exec('BEGIN');await prepareOfflineCreditPrototype(tx,identity,'sale',cmd);db.exec('ROLLBACK');
  assert.equal((await readReadyOfflineCreditPrototype(tx,identity)).length,0);
  const note=await prepareOfflineCreditPrototype(tx,identity,'sale',cmd);assert.equal(note.balanceDelta,-600000);assert.equal(note.retainedCredit,200000);
  assert.equal((await readAllOfflineCreditPrototype(tx,identity))[0].pending,true);
  db.prepare('UPDATE offline_credit_prototype SET payload=?').run(JSON.stringify({...note,balanceDelta:0}));
  await assert.rejects(readAllOfflineCreditPrototype(tx,identity),/Montants/);
  await assert.rejects(acknowledgeOfflineCreditPrototype(tx,identity,{...note,balanceDelta:0},{status:'received',operationId}),/Montants/);
  db.prepare('UPDATE offline_credit_prototype SET payload=?').run(JSON.stringify(note));
  await assert.rejects(prepareOfflineCreditPrototype(tx,identity,'sale',{...cmd,operationId:randomUUID()}),/déjà annulée/);
  assert.equal((await readReadyOfflineCreditPrototype(tx,identity)).length,0);
  db.prepare('DELETE FROM sales_outbox WHERE sale_id=?').run(id);
  assert.equal((await readReadyOfflineCreditPrototype(tx,identity)).length,1);
  await assert.rejects(acknowledgeOfflineCreditPrototype(tx,identity,note,{status:'received',operationId:randomUUID()}),/Accusé/);
  assert.equal((await readReadyOfflineCreditPrototype(tx,identity)).length,1);
  db.exec('BEGIN');await acknowledgeOfflineCreditPrototype(tx,identity,note,{status:'received',operationId});db.exec('ROLLBACK');
  assert.equal((await readReadyOfflineCreditPrototype(tx,identity)).length,1);
  await acknowledgeOfflineCreditPrototype(tx,identity,note,{status:'duplicate',operationId});
  assert.equal((await readReadyOfflineCreditPrototype(tx,identity)).length,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM offline_credit_prototype').get()?.n,1);assert.equal((await readAllOfflineCreditPrototype(tx,identity))[0].pending,false);
 }finally{db.close();}
});
test('avoir préétabli isolé : n’annule pas le paiement d’ancienne dette',async()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,payload TEXT);CREATE TABLE sales_outbox(operation_id TEXT,sale_id TEXT,payload TEXT);
   CREATE TABLE journal_sync_outbox(operation_id TEXT,invoice_id TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(pre_invoice_id TEXT,payload TEXT);
   ${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}`);
  const tx={getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[],getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null,runAsync:async(sql:string,...args:(string|number|null)[])=>{db.prepare(sql).run(...args)}};
  const identity={commercialId:randomUUID(),serverOrigin:'https://example.test'},id=randomUUID(),journalOp=randomUUID(),clientId=randomUUID();
  db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);
  const invoice={id,clientId,journalDate:'2026-11-08',createdAt:'2026-11-08T09:00:00.000Z',amount:600000};
  const receipt={prePaid:200000,oldDebtPaid:300000,creditFull:false,createdAt:'2026-11-08T10:00:00.000Z'};
  const snapshot={operationId:journalOp,version:2,invoice,receipts:[receipt]};
  db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?)').run(id,JSON.stringify(invoice));db.prepare('INSERT INTO tour_journal_receipts VALUES(?,?)').run(id,JSON.stringify(receipt));
  db.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(id,2,JSON.stringify(snapshot));
  db.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(journalOp,identity.commercialId,'journal',id,receipt.createdAt);
  db.prepare('INSERT INTO journal_sync_outbox VALUES(?,?,?)').run(journalOp,id,'{}');
  const cmd={operationId:randomUUID(),invoiceId:id,expectedVersion:2,recordedAt:'2026-11-08T11:00:00.000Z',choice:'refund' as const};
  const note=await prepareOfflineCreditPrototype(tx,identity,'preinvoice',cmd);assert.equal(note.refund,200000);assert.equal(note.balanceDelta,-400000);
  assert.equal((await readReadyOfflineCreditPrototype(tx,identity)).length,0);
  db.prepare('DELETE FROM journal_sync_outbox').run();assert.equal((await readReadyOfflineCreditPrototype(tx,identity)).length,1);
 }finally{db.close();}
});
