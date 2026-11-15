import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';import {tourCloseQueueSchema} from '../../../apps/mobile/tour-close-queue.js';import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference} from '../../../apps/mobile/day-invoice-reference-cache.js';import {dayInvoiceQueueSchema} from '../../../apps/mobile/day-invoice-queue.js';import {saleEventTimeSchema} from '../../../apps/mobile/sale-event-time.js';
import {draftSaleLines,parseSaleEditLines} from '../../../apps/mobile/day-invoice-sale-edit-input.js';
import {captureDayInvoiceSaleEdit,confirmDayInvoiceSaleEdit} from '../../../apps/mobile/day-invoice-sale-edit.js';import {captureDayInvoiceForm,confirmDayInvoiceForm} from '../../../apps/mobile/day-invoice-form.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',saleId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',invoiceId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',identity={commercialId:clientId,serverOrigin:'https://example.test'},day='2026-01-01',at='2026-01-01T09:00:00.000Z';
const saleOperation='11111111-1111-4111-8111-111111111111',editOperation='22222222-2222-4222-8222-222222222222',paymentOperation='33333333-3333-4333-8333-333333333333';
const line={name:'Produit',code:'X',quantity:5,unitPrice:50000,discount:0,vat:0},sale={createdAt:at,clientId,clientName:'Client',syncSaleId:saleId,syncVersion:1,lines:[line],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
const payment={operationId:paymentOperation,clientId,day,recordedAt:at,amount:800000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]};
const reference={version:6,clients:[{id:clientId,name:'Client',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'50000'}],articles:[],saleStates:[{saleId,clientId,version:1,total:'250000',paid:'0'}],saleDays:[{saleId,clientId,day}],settlementStates:[],settlementDays:[],settlementProofs:[],oldDebtMarkers:[],journalStates:[{id:invoiceId,clientId,journalDate:day,total:600000,receipts:[],declaredByDayPayment:true}],journalProofs:[{id:invoiceId,version:1,hash:'a'.repeat(64)}],dayPayments:[payment]};
const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');
function setup(){const db=new DatabaseSync(':memory:');db.exec(`${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}${saleEventTimeSchema}
 CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
 CREATE TABLE sale_revisions(id INTEGER PRIMARY KEY,sale_id INTEGER,created_at TEXT,previous_payload TEXT,new_payload TEXT,refund INTEGER);
 CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);
 CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);`);
 db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);db.prepare('INSERT INTO sales VALUES(1,?,?)').run(clientId,JSON.stringify(sale));db.prepare("INSERT INTO identified_local_operations VALUES(?,?,'sale',?,?)").run(saleOperation,clientId,saleId,at);
 const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};return {db,tx};}
test('révision v6 hors ligne : aperçu combiné, trop-perçu refusé et écriture atomique',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  const draft=draftSaleLines([line]);draft[0].quantity='6';const increase=parseSaleEditLines(draft),preview=await captureDayInvoiceSaleEdit(tx,identity,1,increase,digest);assert.equal(preview.assessment.total,900000);assert.equal(preview.assessment.paid,800000);assert.equal(preview.assessment.remaining,100000);assert.equal(preview.balanceAfter,100000);
  const decrease=[{...line,quantity:3}],danger=await captureDayInvoiceSaleEdit(tx,identity,1,decrease,digest);assert.equal(danger.assessment.excess,50000);assert.equal(danger.assessment.requiresChoice,true);
  db.exec('BEGIN');await assert.rejects(confirmDayInvoiceSaleEdit(tx,identity,{saleId:1,lines:decrease,fingerprint:danger.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'},digest),/remboursement ou crédit/);db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) n FROM sale_revisions').get()?.n,0);
  db.exec('BEGIN');await assert.rejects(confirmDayInvoiceSaleEdit(tx,identity,{saleId:1,lines:increase,fingerprint:'périmé',operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'},digest),/changé/);db.exec('ROLLBACK');
  db.exec('BEGIN');const result=await confirmDayInvoiceSaleEdit(tx,identity,{saleId:1,lines:increase,fingerprint:preview.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'},digest);db.exec('COMMIT');
  assert.equal(result.updated.total,300000);assert.equal(result.updated.syncVersion,2);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,1);assert.equal(db.prepare('SELECT count(*) n FROM sale_revisions').get()?.n,1);
  await assert.rejects(captureDayInvoiceSaleEdit(tx,identity,1,increase,digest),/Opérations en attente/);
  const after=await captureDayInvoiceForm(tx,identity,clientId,day,digest);assert.equal(after.view.total,900000);assert.equal(after.view.remaining,100000);
  const extraPayment='44444444-4444-4444-8444-444444444444';
  db.exec('BEGIN');await confirmDayInvoiceForm(tx,identity,{clientId,day,fingerprint:after.fingerprint,operationId:extraPayment,recordedAt:'2026-01-01T10:01:00.000Z',amount:50000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''},digest);db.exec('COMMIT');
  assert.equal((await captureDayInvoiceForm(tx,identity,clientId,day,digest)).view.remaining,50000);
  assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payment_outbox').get()?.n,1);
 }finally{db.close();}
});
test('révision v6 : source, identité, lignes et opérations en attente sont contrôlées',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  await assert.rejects(captureDayInvoiceSaleEdit(tx,{...identity,serverOrigin:'https://other.test'},1,[line],digest),/Identité/);
  await assert.rejects(captureDayInvoiceSaleEdit(tx,identity,1,[{...line,unitPrice:1}],digest),/Article/);
  db.prepare('UPDATE sales SET payload=?').run(JSON.stringify({...sale,total:249000}));await assert.rejects(captureDayInvoiceSaleEdit(tx,identity,1,[line],digest),/incohérentes/);
  db.prepare('UPDATE sales SET payload=?').run(JSON.stringify(sale));db.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(editOperation,saleId,2,'{}');
  await assert.rejects(captureDayInvoiceSaleEdit(tx,identity,1,[line],digest),/Opérations en attente/);
 }finally{db.close();}
});
test('révision v6 : toute erreur pendant l’écriture annule vente, historique et file',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  const lines=[{...line,quantity:6}],preview=await captureDayInvoiceSaleEdit(tx,identity,1,lines,digest);
  const failing={...tx,runAsync:async(sql:string,...args:(string|number|null)[])=>{if(sql.startsWith('INSERT INTO sales_outbox'))throw Error('échec simulé');await tx.runAsync(sql,...args);}};
  db.exec('BEGIN');await assert.rejects(confirmDayInvoiceSaleEdit(failing,identity,{saleId:1,lines,fingerprint:preview.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'},digest),/échec simulé/);db.exec('ROLLBACK');
  assert.deepEqual(JSON.parse(String(db.prepare('SELECT payload FROM sales WHERE id=1').get()?.payload)),sale);
  for(const table of ['sale_revisions','sales_outbox','sale_event_times'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM identified_local_operations WHERE operation_id=?').get(editOperation)?.n,0);
  const fresh=await captureDayInvoiceSaleEdit(tx,identity,1,lines,digest);assert.equal(fresh.fingerprint,preview.fingerprint);
  db.exec('BEGIN');await confirmDayInvoiceSaleEdit(tx,identity,{saleId:1,lines,fingerprint:fresh.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'},digest);db.exec('COMMIT');
 }finally{db.close();}
});

test('révision en attente : preuve locale altérée ou file disparue bloque la projection',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  const lines=[{...line,quantity:6}],preview=await captureDayInvoiceSaleEdit(tx,identity,1,lines,digest);
  await confirmDayInvoiceSaleEdit(tx,identity,{saleId:1,lines,fingerprint:preview.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'},digest);
  assert.equal((await captureDayInvoiceForm(tx,identity,clientId,day,digest)).view.remaining,100000);
  const queued=String(db.prepare('SELECT payload FROM sales_outbox').get()?.payload),event=JSON.parse(queued);
  db.prepare('UPDATE sales_outbox SET payload=?').run(JSON.stringify({...event,refund:1}));await assert.rejects(captureDayInvoiceForm(tx,identity,clientId,day,digest),/incohérentes/);
  db.prepare('UPDATE sales_outbox SET payload=?').run(queued);db.prepare('UPDATE sale_revisions SET refund=1').run();await assert.rejects(captureDayInvoiceForm(tx,identity,clientId,day,digest),/incohérentes/);
  db.prepare('UPDATE sale_revisions SET refund=0').run();db.prepare('DELETE FROM sales_outbox').run();await assert.rejects(captureDayInvoiceForm(tx,identity,clientId,day,digest),/incohérentes/);
 }finally{db.close();}
});
