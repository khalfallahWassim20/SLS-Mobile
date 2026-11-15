import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {appendDayInvoicePayment,acknowledgeDayInvoicePayment,readDayInvoicePayments,readDayInvoiceOutbox,dayInvoiceQueueSchema} from '../../../apps/mobile/day-invoice-queue.js';
import type {DayInvoicePayment} from '../src/day-invoice.js';

const payment:DayInvoicePayment={operationId:'11111111-1111-4111-8111-111111111111',clientId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',day:'2026-01-01',recordedAt:'2026-01-01T12:00:00.000Z',amount:150000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',version:1,total:600000,declare:true},sales:[{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',version:1}]};
const setup=()=>{
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON;'+dayInvoiceQueueSchema);
 const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};
 return {db,tx};
};
const guard=async()=>{};
const identity={commercialId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',serverOrigin:'https://example.test'};
test('écriture du paiement et file atomique, reprise identique et rejet du contenu divergent',async()=>{
 const {db,tx}=setup();try {
  db.exec('BEGIN');assert.equal(await appendDayInvoicePayment(tx,payment,identity,guard),'created');db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payments').get()?.n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payment_outbox').get()?.n,0);
  db.exec('BEGIN');assert.equal(await appendDayInvoicePayment(tx,payment,identity,guard),'created');db.exec('COMMIT');
  assert.equal(await appendDayInvoicePayment(tx,payment,identity,guard),'duplicate');
  await assert.rejects(appendDayInvoicePayment(tx,{...payment,amount:1000},identity,guard),/déjà utilisé/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payments').get()?.n,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payment_outbox').get()?.n,1);
 } finally {db.close();}
});
test('garde fermée et accusé inexact ne suppriment aucune opération',async()=>{
 const {db,tx}=setup();try {
  await assert.rejects(appendDayInvoicePayment(tx,payment,identity,async()=>{throw Error('Journée clôturée');}),/clôturée/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payments').get()?.n,0);
  await appendDayInvoicePayment(tx,payment,identity,guard);
  const entry=db.prepare('SELECT sequence,operation_id AS operationId,payload,commercial_id AS commercialId,server_origin AS serverOrigin FROM day_invoice_payment_outbox').get() as {sequence:number;operationId:string;payload:string;commercialId:string;serverOrigin:string};
  await assert.rejects(acknowledgeDayInvoicePayment(tx,{...entry,payload:'{}'}),/modifiée/);
  db.exec('BEGIN');await acknowledgeDayInvoicePayment(tx,entry);db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payment_outbox').get()?.n,1);
  await acknowledgeDayInvoicePayment(tx,entry);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payment_outbox').get()?.n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payments').get()?.n,1);
 } finally {db.close();}
});
test('erreur entre insertion du paiement et insertion en file : transaction annulée',async()=>{
 const {db,tx}=setup();try {
  const failing={...tx,runAsync:async(sql:string,...args:(string|number|null)[])=>{
   if(sql.startsWith('INSERT INTO day_invoice_payment_outbox'))throw Error('stockage saturé');
   await tx.runAsync(sql,...args);
  }};
  db.exec('BEGIN');try {await appendDayInvoicePayment(failing,payment,identity,guard);assert.fail('erreur attendue');} catch(error){assert.match(String(error),/saturé/);db.exec('ROLLBACK');}
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payments').get()?.n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payment_outbox').get()?.n,0);
 } finally {db.close();}
});

test('un événement lié à un autre commercial ou serveur est refusé même après accusé',async()=>{
 const {db,tx}=setup();try {
  await appendDayInvoicePayment(tx,payment,identity,guard);
  const entry=db.prepare('SELECT sequence,operation_id AS operationId,payload,commercial_id AS commercialId,server_origin AS serverOrigin FROM day_invoice_payment_outbox').get() as {sequence:number;operationId:string;payload:string;commercialId:string;serverOrigin:string};
  await assert.rejects(acknowledgeDayInvoicePayment(tx,{...entry,commercialId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}),/modifiée/);
  await acknowledgeDayInvoicePayment(tx,entry);
  await assert.rejects(appendDayInvoicePayment(tx,payment,{...identity,serverOrigin:'https://other.test'},guard),/déjà utilisé/);
 } finally {db.close();}
});

test('accusé refuse une divergence entre événement conservé et file',async()=>{
 const {db,tx}=setup();try {
  await appendDayInvoicePayment(tx,payment,identity,guard);
  const entry=db.prepare('SELECT sequence,operation_id AS operationId,payload,commercial_id AS commercialId,server_origin AS serverOrigin FROM day_invoice_payment_outbox').get() as {sequence:number;operationId:string;payload:string;commercialId:string;serverOrigin:string};
  db.prepare('UPDATE day_invoice_payments SET payload=? WHERE operation_id=?').run('{}',payment.operationId);
  await assert.rejects(acknowledgeDayInvoicePayment(tx,entry),/modifiée/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payment_outbox').get()?.n,1);
 } finally {db.close();}
});
test('lecture des paiements vérifie identité, contenu et correspondance des colonnes',async()=>{
 const {db,tx}=setup();try {
  await appendDayInvoicePayment(tx,payment,identity,guard);
  assert.deepEqual(await readDayInvoicePayments(tx,identity,payment.clientId,payment.day),[payment]);
  assert.deepEqual(await readDayInvoicePayments(tx,identity,payment.clientId,'2026-01-02'),[]);
  await assert.rejects(readDayInvoicePayments(tx,{...identity,serverOrigin:'https://other.test'},payment.clientId,payment.day),/autre commercial/);
  db.prepare('UPDATE day_invoice_payments SET payload=?').run(JSON.stringify({...payment,clientId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}));
  await assert.rejects(readDayInvoicePayments(tx,identity,payment.clientId,payment.day),/incohérent/);
 } finally {db.close();}
});

test('accusé refuse une modification des colonnes client ou journée après capture',async()=>{
 const {db,tx}=setup();try{
  await appendDayInvoicePayment(tx,payment,identity,guard);
  const entry=db.prepare('SELECT sequence,operation_id AS operationId,payload,commercial_id AS commercialId,server_origin AS serverOrigin FROM day_invoice_payment_outbox').get() as {sequence:number;operationId:string;payload:string;commercialId:string;serverOrigin:string};
  db.prepare('UPDATE day_invoice_payments SET client_id=?').run('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');await assert.rejects(acknowledgeDayInvoicePayment(tx,entry),/modifiée/);
  db.prepare('UPDATE day_invoice_payments SET client_id=?,invoice_day=?').run(payment.clientId,'2026-01-02');await assert.rejects(acknowledgeDayInvoicePayment(tx,entry),/modifiée/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payment_outbox').get()?.n,1);
 }finally{db.close();}
});

test('capture de file refuse les mouvements orphelins, modifiés ou étrangers',async()=>{
 const {db,tx}=setup();try{
  await appendDayInvoicePayment(tx,payment,identity,guard);assert.equal((await readDayInvoiceOutbox(tx,identity)).length,1);
  db.prepare('UPDATE day_invoice_payments SET invoice_day=?').run('2026-01-02');await assert.rejects(readDayInvoiceOutbox(tx,identity),/incohérent/);
  db.prepare('UPDATE day_invoice_payments SET invoice_day=?').run(payment.day);await assert.rejects(readDayInvoiceOutbox(tx,{...identity,serverOrigin:'https://other.test'}),/identité/);
  db.exec('PRAGMA foreign_keys=OFF');db.exec('DELETE FROM day_invoice_payments');await assert.rejects(readDayInvoiceOutbox(tx,identity),/incohérente/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payment_outbox').get()?.n,1);
 }finally{db.close();}
});
