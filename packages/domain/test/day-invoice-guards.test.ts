import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {guardDayInvoiceWrite} from '../../../apps/mobile/day-invoice-guards.js';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema} from '../../../apps/mobile/tour-close-queue.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import type {DayInvoicePayment} from '../src/day-invoice.js';
import {writeLocalDayInvoicePayment} from '../../../apps/mobile/day-invoice-local.js';
import {dayInvoiceQueueSchema} from '../../../apps/mobile/day-invoice-queue.js';
import {dayInvoiceOldDebtSchema} from '../../../apps/mobile/day-invoice-old-debt-queue.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',invoiceId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',saleId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const identity={commercialId:clientId,serverOrigin:'https://example.test'};
const payment:DayInvoicePayment={operationId:'11111111-1111-4111-8111-111111111111',clientId,day:'2026-01-01',recordedAt:'2026-01-01T12:00:00.000Z',amount:200000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]};
const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');
function setup(){const db=new DatabaseSync(':memory:');db.exec(`${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceOldDebtSchema}CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);CREATE TABLE sales_outbox(operation_id TEXT);CREATE TABLE journal_sync_outbox(operation_id TEXT);`);
 db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);db.prepare('INSERT INTO sales(client_id,payload) VALUES(?,?)').run(clientId,JSON.stringify({syncSaleId:saleId,syncVersion:1,clientId,total:250000,paid:0}));db.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(invoiceId,1,'{}');
 const insert=db.prepare('INSERT INTO identified_local_operations(operation_id,commercial_id,operation_kind,entity_id,recorded_at) VALUES(?,?,?,?,?)');insert.run('22222222-2222-4222-8222-222222222222',clientId,'sale',saleId,payment.recordedAt);insert.run('33333333-3333-4333-8333-333333333333',clientId,'journal',invoiceId,payment.recordedAt);
 const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};return {db,tx};}
test('gardes réelles : identité, sources connues et clôture ouverte',async()=>{const {db,tx}=setup();try{await guardDayInvoiceWrite(tx,identity,payment,digest);await assert.rejects(guardDayInvoiceWrite(tx,{...identity,serverOrigin:'https://other.test'},payment,digest),/Identité/);db.prepare("INSERT INTO tour_known_server_states VALUES(?,?,'closed',1)").run(clientId,payment.day);await assert.rejects(guardDayInvoiceWrite(tx,identity,payment,digest),/clôturée/);}finally{db.close();}});
test('gardes réelles : refuse réutilisation de UUID et source liée à un autre commercial',async()=>{const {db,tx}=setup();try{db.prepare('INSERT INTO sales_outbox VALUES(?)').run(payment.operationId);await assert.rejects(guardDayInvoiceWrite(tx,identity,payment,digest),/déjà utilisé/);db.exec('DELETE FROM sales_outbox');db.prepare("UPDATE identified_local_operations SET commercial_id=? WHERE operation_kind='sale'").run('dddddddd-dddd-4ddd-8ddd-dddddddddddd');await assert.rejects(guardDayInvoiceWrite(tx,identity,payment,digest),/autre commercial/);}finally{db.close();}});

test('écriture SQLite réelle : vérifications, solde du jour et file en une transaction',async()=>{const {db,tx}=setup();try{
 db.exec(`CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(pre_invoice_id TEXT,payload TEXT);CREATE TABLE settlements(client_id TEXT,payload TEXT);${dayInvoiceQueueSchema}`);
 const invoice={id:invoiceId,clientId,clientName:'Client',journalDate:payment.day,sector:'',amount:600000,createdAt:'2026-01-01T09:00:00.000Z'};
 db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(invoiceId,clientId,payment.day,JSON.stringify(invoice));
 db.prepare('UPDATE journal_sync_state SET payload=?').run(JSON.stringify({version:1,invoice,receipts:[]}));
 db.prepare('UPDATE sales SET payload=?').run(JSON.stringify({syncSaleId:saleId,syncVersion:1,clientId,clientName:'Client',createdAt:'2026-01-01T09:00:00.000Z',total:250000,paid:0}));
 db.exec('BEGIN');assert.equal(await writeLocalDayInvoicePayment(tx,identity,payment,(t,id,p)=>guardDayInvoiceWrite(t,id,p,digest)),'created');db.exec('COMMIT');
 assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payment_outbox').get()?.n,1);
 db.prepare("INSERT INTO tour_known_server_states VALUES(?,?,'closed',1)").run(clientId,payment.day);
 const next={...payment,operationId:'44444444-4444-4444-8444-444444444444',preInvoice:{...payment.preInvoice!,declare:false}};
 db.exec('BEGIN');await assert.rejects(writeLocalDayInvoicePayment(tx,identity,next,(t,id,p)=>guardDayInvoiceWrite(t,id,p,digest)),/clôturée/);db.exec('ROLLBACK');
 assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payments').get()?.n,1);
 }finally{db.close();}});

test('écriture rapprochée : aucun paiement sans référence ni preuve complète de toutes les sources',async()=>{
 const {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference}=await import('../../../apps/mobile/day-invoice-reference-cache.js');
 const {writeReconciledDayInvoicePayment}=await import('../../../apps/mobile/day-invoice-local.js');
 const {db,tx}=setup();try{
  db.exec(`CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(pre_invoice_id TEXT,payload TEXT);CREATE TABLE settlements(client_id TEXT,payload TEXT);${dayInvoiceQueueSchema}${dayInvoiceReferenceCacheSchema}`);
  const invoice={id:invoiceId,clientId,clientName:'Client',journalDate:payment.day,sector:'',amount:600000,createdAt:'2026-01-01T09:00:00.000Z'};
  db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(invoiceId,clientId,payment.day,JSON.stringify(invoice));
  db.prepare('UPDATE journal_sync_state SET payload=?').run(JSON.stringify({version:1,invoice,receipts:[]}));
  db.prepare('UPDATE sales SET payload=?').run(JSON.stringify({syncSaleId:saleId,syncVersion:1,clientId,clientName:'Client',createdAt:'2026-01-01T09:00:00.000Z',total:250000,paid:0}));
  await assert.rejects(writeReconciledDayInvoicePayment(tx,identity,payment,async()=>{}),/Référence facture du jour indisponible/);
  const remoteSale='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const ref={version:6,clients:[{id:clientId,name:'Client',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'350000'}],articles:[],saleStates:[{saleId,clientId,version:1,total:'250000',paid:'0'},{saleId:remoteSale,clientId,version:1,total:'100000',paid:'0'}],saleDays:[{saleId,clientId,day:payment.day},{saleId:remoteSale,clientId,day:payment.day}],settlementStates:[],settlementDays:[],settlementProofs:[],journalStates:[{id:invoiceId,clientId,journalDate:payment.day,total:600000,receipts:[],declaredByDayPayment:false}],journalProofs:[{id:invoiceId,version:1,hash:'a'.repeat(64)}],dayPayments:[]};
  await saveDayInvoiceReference(tx,identity,identity,ref);
  await assert.rejects(writeReconciledDayInvoicePayment(tx,identity,payment,async()=>{}),/Ventes modifiées/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payments').get()?.n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payment_outbox').get()?.n,0);
 }finally{db.close();}
});

test('écriture rapprochée : règlement distant déjà encaissé limite le montant local',async()=>{
 const {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference}=await import('../../../apps/mobile/day-invoice-reference-cache.js');
 const {writeReconciledDayInvoicePayment}=await import('../../../apps/mobile/day-invoice-local.js');
 const {db,tx}=setup();try{
  db.exec(`CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(pre_invoice_id TEXT,payload TEXT);CREATE TABLE settlements(client_id TEXT,payload TEXT);${dayInvoiceQueueSchema}${dayInvoiceReferenceCacheSchema}`);
  const invoice={id:invoiceId,clientId,clientName:'Client',journalDate:payment.day,sector:'',amount:600000,createdAt:'2026-01-01T09:00:00.000Z'};
  db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(invoiceId,clientId,payment.day,JSON.stringify(invoice));db.prepare('UPDATE journal_sync_state SET payload=?').run(JSON.stringify({version:1,invoice,receipts:[]}));db.prepare('UPDATE sales SET payload=?').run(JSON.stringify({syncSaleId:saleId,syncVersion:1,clientId,clientName:'Client',createdAt:'2026-01-01T09:00:00.000Z',total:250000,paid:0}));
  const ref={version:6,clients:[{id:clientId,name:'Client',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'650000'}],articles:[],saleStates:[{saleId,clientId,version:1,total:'250000',paid:'0'}],saleDays:[{saleId,clientId,day:payment.day}],settlementStates:[],settlementDays:[],settlementProofs:[],journalStates:[{id:invoiceId,clientId,journalDate:payment.day,total:600000,receipts:[],declaredByDayPayment:true}],journalProofs:[{id:invoiceId,version:1,hash:'a'.repeat(64)}],dayPayments:[payment]};
  await saveDayInvoiceReference(tx,identity,identity,ref);
  const tooMuch={...payment,operationId:'44444444-4444-4444-8444-444444444444',amount:650001,preInvoice:{...payment.preInvoice!,declare:false}};
  await assert.rejects(writeReconciledDayInvoicePayment(tx,identity,tooMuch,async()=>{}),/supérieur/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payments').get()?.n,0);
  const exact={...tooMuch,amount:650000};assert.equal(await writeReconciledDayInvoicePayment(tx,identity,exact,async()=>{}),'created');
 }finally{db.close();}
});

test('formulaire unifié : capture de 850 DT, confirmation atomique et refus de capture périmée',async()=>{
 const {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference}=await import('../../../apps/mobile/day-invoice-reference-cache.js');
 const {captureDayInvoiceForm,confirmDayInvoiceForm}=await import('../../../apps/mobile/day-invoice-form.js');
 const {db,tx}=setup();try{
  db.exec(`CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(pre_invoice_id TEXT,payload TEXT);CREATE TABLE settlements(client_id TEXT,payload TEXT);${dayInvoiceQueueSchema}${dayInvoiceReferenceCacheSchema}`);
  const invoice={id:invoiceId,clientId,clientName:'Client',journalDate:payment.day,sector:'',amount:600000,createdAt:'2026-01-01T09:00:00.000Z'};
  db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(invoiceId,clientId,payment.day,JSON.stringify(invoice));
  db.prepare('UPDATE journal_sync_state SET payload=?').run(JSON.stringify({version:1,invoice,receipts:[]}));
  db.prepare('UPDATE sales SET payload=?').run(JSON.stringify({syncSaleId:saleId,syncVersion:1,clientId,clientName:'Client',createdAt:'2026-01-01T09:00:00.000Z',total:250000,paid:0}));
  const ref={version:6,clients:[{id:clientId,name:'Client',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'250000'}],articles:[],saleStates:[{saleId,clientId,version:1,total:'250000',paid:'0'}],saleDays:[{saleId,clientId,day:payment.day}],settlementStates:[],settlementDays:[],settlementProofs:[],journalStates:[{id:invoiceId,clientId,journalDate:payment.day,total:600000,receipts:[],declaredByDayPayment:false}],journalProofs:[{id:invoiceId,version:1,hash:'a'.repeat(64)}],dayPayments:[]};
  await saveDayInvoiceReference(tx,identity,identity,ref);
  const draft=await captureDayInvoiceForm(tx,identity,clientId,payment.day);assert.deepEqual([draft.view.preInvoiceTotal,draft.view.salesTotal,draft.view.total,draft.view.paid,draft.view.remaining],[600000,250000,850000,0,850000]);
  const input={clientId,day:payment.day,fingerprint:draft.fingerprint,operationId:payment.operationId,recordedAt:payment.recordedAt,amount:200000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:''};
  db.exec('BEGIN');const result=await confirmDayInvoiceForm(tx,identity,input,digest);db.exec('COMMIT');assert.equal(result.payment.preInvoice?.declare,true);assert.deepEqual(result.payment.sales,[{id:saleId,version:1}]);
  const after=await captureDayInvoiceForm(tx,identity,clientId,payment.day);assert.equal(after.view.remaining,650000);assert.equal(after.view.paid,200000);assert.equal(after.view.payments[0].pending,true);
  // Perte du résultat local après COMMIT : reprise du même identifiant, sans
  // deuxième encaissement ni nouvelle empreinte de facture.
  db.exec('BEGIN');const retry=await confirmDayInvoiceForm(tx,identity,input,digest);db.exec('COMMIT');assert.equal(retry.status,'duplicate');assert.deepEqual(retry.payment,result.payment);
  await assert.rejects(confirmDayInvoiceForm(tx,identity,{...input,amount:100000},digest),/déjà utilisé/);
  await assert.rejects(confirmDayInvoiceForm(tx,{...identity,serverOrigin:'https://other.test'},input,digest),/Identité/);
  db.exec('BEGIN');db.prepare("UPDATE day_invoice_payment_outbox SET payload='{}'").run();await assert.rejects(confirmDayInvoiceForm(tx,identity,input,digest),/incohérente/);db.exec('ROLLBACK');
  db.exec('BEGIN');db.prepare('DELETE FROM day_invoice_payment_outbox').run();await assert.rejects(confirmDayInvoiceForm(tx,identity,input,digest),/Accusé/);db.exec('ROLLBACK');
  db.exec('BEGIN');await assert.rejects(confirmDayInvoiceForm(tx,identity,{...input,operationId:'44444444-4444-4444-8444-444444444444'},digest),/a changé/);db.exec('ROLLBACK');
  db.exec('BEGIN');await assert.rejects(confirmDayInvoiceForm(tx,identity,{...input,fingerprint:after.fingerprint,operationId:'44444444-4444-4444-8444-444444444444',amount:650001},digest),/supérieur/);db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payments').get()?.n,1);
 }finally{db.close();}
});

test('formulaire intercommercial : facture et vente distantes prouvées, sans copie locale',async()=>{
 const {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference}=await import('../../../apps/mobile/day-invoice-reference-cache.js');
 const {captureDayInvoiceForm,confirmDayInvoiceForm}=await import('../../../apps/mobile/day-invoice-form.js');
 const {db,tx}=setup();try{
  db.exec(`CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(pre_invoice_id TEXT,payload TEXT);CREATE TABLE settlements(client_id TEXT,payload TEXT);${dayInvoiceQueueSchema}${dayInvoiceReferenceCacheSchema}`);
  db.exec('DELETE FROM sales;DELETE FROM journal_sync_state;DELETE FROM identified_local_operations');
  const ref={version:6,clients:[{id:clientId,name:'Client',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'250000'}],articles:[],saleStates:[{saleId,clientId,version:1,total:'250000',paid:'0'}],saleDays:[{saleId,clientId,day:payment.day}],settlementStates:[],settlementDays:[],settlementProofs:[],journalStates:[{id:invoiceId,clientId,journalDate:payment.day,total:600000,receipts:[],declaredByDayPayment:false}],journalProofs:[{id:invoiceId,version:1,hash:'a'.repeat(64)}],dayPayments:[]};
  await saveDayInvoiceReference(tx,identity,identity,ref);
  const form=await captureDayInvoiceForm(tx,identity,clientId,payment.day);assert.equal(form.view.total,850000);assert.equal(form.remoteOnlyPreInvoice,true);assert.deepEqual(form.remoteOnlySaleIds,[saleId]);
  const input={clientId,day:payment.day,fingerprint:form.fingerprint,operationId:payment.operationId,recordedAt:payment.recordedAt,amount:200000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:''};
  db.exec('BEGIN');const saved=await confirmDayInvoiceForm(tx,identity,input,digest);db.exec('COMMIT');assert.equal(saved.payment.preInvoice?.declare,true);assert.deepEqual(saved.payment.sales,[{id:saleId,version:1}]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sales').get()?.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM tour_pre_invoices').get()?.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payment_outbox').get()?.n,1);
  const next=await captureDayInvoiceForm(tx,identity,clientId,payment.day);assert.equal(next.view.remaining,650000);
  await assert.rejects(guardDayInvoiceWrite(tx,identity,{...payment,operationId:'77777777-7777-4777-8777-777777777777',sales:[{id:saleId,version:2}]},digest,true),/distante/);
 }finally{db.close();}
});
