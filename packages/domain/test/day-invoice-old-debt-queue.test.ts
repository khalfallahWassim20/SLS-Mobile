import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema,prepareTourClose,prepareExperimentalDayInvoiceTourClose} from '../../../apps/mobile/tour-close-queue.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference} from '../../../apps/mobile/day-invoice-reference-cache.js';
import {dayInvoiceQueueSchema} from '../../../apps/mobile/day-invoice-queue.js';
import {captureOldDebtForm,confirmOldDebtForm} from '../../../apps/mobile/day-invoice-old-debt-form.js';
import {prepareOldDebtInput} from '../../../apps/mobile/day-invoice-old-debt-input.js';
import {captureDayInvoiceForm} from '../../../apps/mobile/day-invoice-form.js';
import {acknowledgeOldDebt,readOldDebtOutbox,type OldDebtEvent} from '../../../apps/mobile/day-invoice-old-debt-queue.js';
import {uploadOldDebts} from '../../../apps/mobile/day-invoice-old-debt-upload.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',saleId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',invoiceId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const identity={commercialId:clientId,serverOrigin:'https://example.test'},day='2026-01-01',at='2026-01-01T09:00:00.000Z';
const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');
function setup(){const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}
 CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,created_at TEXT,client_id TEXT,payload TEXT);
 CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);
 CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);`);
 db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);
 const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};return {db,tx};}
const reference={version:6,clients:[{id:clientId,name:'Client',sector:'Nord',openingBalance:'100000',creditLimit:'0',serverBalance:'350000'}],articles:[],saleStates:[{saleId,clientId,version:1,total:'250000',paid:'0'}],saleDays:[{saleId,clientId,day}],settlementStates:[],settlementDays:[],settlementProofs:[],journalStates:[{id:invoiceId,clientId,journalDate:day,total:600000,receipts:[],declaredByDayPayment:false}],journalProofs:[{id:invoiceId,version:1,hash:'a'.repeat(64)}],dayPayments:[]};
function debt(id:string,amount:number):OldDebtEvent{return {invoiceDay:day,event:{operationId:id,settlement:{syncOperationId:id,createdAt:at,clientId,clientName:'Client',amount,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}}};}
const id='11111111-1111-4111-8111-111111111111',id2='22222222-2222-4222-8222-222222222222';
test('dette explicite hors ligne : plafond, facture inchangée, reprise et accusé exact',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  const initial=await captureOldDebtForm(tx,identity,clientId,day,digest);assert.equal(initial.balance,350000);assert.equal(initial.available,100000);
  const prepared=prepareOldDebtInput(initial,{amount:'60,000',mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''},id,at);
  db.exec('BEGIN');assert.equal(await confirmOldDebtForm(tx,identity,prepared,digest),'created');db.exec('COMMIT');
  db.exec('BEGIN');assert.equal(await confirmOldDebtForm(tx,identity,prepared,digest),'duplicate');db.exec('COMMIT');
  await assert.rejects(confirmOldDebtForm(tx,identity,{...prepared,event:debt(id,50000)},digest),/déjà utilisé/);
  const after=await captureOldDebtForm(tx,identity,clientId,day,digest);assert.equal(after.balance,290000);assert.equal(after.available,40000);
  const invoice=await captureDayInvoiceForm(tx,identity,clientId,day,digest);assert.equal(invoice.view.total,850000);assert.equal(invoice.view.remaining,850000);
  db.exec('BEGIN');await assert.rejects(confirmOldDebtForm(tx,identity,{fingerprint:initial.fingerprint,event:debt(id2,1000)},digest),/changé/);db.exec('ROLLBACK');
  db.exec('BEGIN');await assert.rejects(confirmOldDebtForm(tx,identity,{fingerprint:after.fingerprint,event:debt(id2,40001)},digest),/supérieur/);db.exec('ROLLBACK');
  await assert.rejects(prepareTourClose(tx,identity.commercialId,day,0,()=>id2),/ancienne dette en attente/);
  await assert.rejects(prepareExperimentalDayInvoiceTourClose(tx,identity.commercialId,day,0,()=>id2),/ancienne dette en attente/);
  const queue=await readOldDebtOutbox(tx,identity);assert.equal(queue.length,1);
  await assert.rejects(uploadOldDebts(queue,identity,identity,async()=>({ok:true,status:200,json:async()=>({status:'received',operationId:id2})}),async()=>{throw Error('ne doit pas acquitter');}),/Accusé invalide/);
  assert.equal((await readOldDebtOutbox(tx,identity)).length,1);
  await uploadOldDebts(queue,identity,identity,async()=>({ok:true,status:200,json:async()=>({status:'duplicate',operationId:id})}),entry=>acknowledgeOldDebt(tx,identity,entry));
  assert.equal((await readOldDebtOutbox(tx,identity)).length,0);assert.equal(db.prepare('SELECT count(*) n FROM settlements').get()?.n,1);
  await assert.rejects(confirmOldDebtForm(tx,identity,prepared,digest),/Accusé/);
  const settled=prepared.event.event.settlement,hash=await digest((await import('@sls/domain')).canonicalJson(settled));
  await saveDayInvoiceReference(tx,identity,identity,{...reference,clients:[{...reference.clients[0],serverBalance:'290000'}],settlementStates:[{operationId:id,clientId}],settlementDays:[{operationId:id,clientId,day}],settlementProofs:[{operationId:id,hash}],oldDebtMarkers:[{operationId:id,invoiceDay:day}]});
  assert.equal(await confirmOldDebtForm(tx,identity,prepared,digest),'duplicate');assert.equal(db.prepare('SELECT count(*) n FROM settlements').get()?.n,1);
 }finally{db.close();}
});
test('dette explicite : contenu altéré ou identité étrangère bloquent la file',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);const form=await captureOldDebtForm(tx,identity,clientId,day,digest);await confirmOldDebtForm(tx,identity,{fingerprint:form.fingerprint,event:debt(id,60000)},digest);
  await assert.rejects(readOldDebtOutbox(tx,{...identity,serverOrigin:'https://wrong.test'}),/Identité/);
  db.prepare('UPDATE settlements SET payload=?').run(JSON.stringify({...debt(id,60000).event.settlement,amount:50000}));await assert.rejects(readOldDebtOutbox(tx,identity),/Historique/);
  assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_old_debt_outbox').get()?.n,1);
 }finally{db.close();}
});
