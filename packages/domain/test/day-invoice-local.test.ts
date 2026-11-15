import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readLocalDayInvoiceSource} from '../../../apps/mobile/day-invoice-local.js';
import {appendDayInvoicePayment,dayInvoiceQueueSchema} from '../../../apps/mobile/day-invoice-queue.js';
import {validateDayInvoiceWrite,type DayInvoicePayment} from '../src/day-invoice.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', invoiceId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',saleId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const identity={commercialId:clientId,serverOrigin:'https://example.test'},day='2026-01-01';
const pre={id:invoiceId,clientId,clientName:'Client',journalDate:day,sector:'',amount:600000,createdAt:'2026-01-01T09:00:00.000Z'};
const sale={id:1,clientId,clientName:'Client',createdAt:'2026-01-01T10:00:00.000Z',syncSaleId:saleId,syncVersion:1,total:250000,paid:0};
const event:DayInvoicePayment={operationId:'11111111-1111-4111-8111-111111111111',clientId,day,recordedAt:'2026-01-01T12:00:00.000Z',amount:200000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]};
function setup(){const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);CREATE TABLE tour_journal_receipts(pre_invoice_id TEXT,payload TEXT);CREATE TABLE sales(id INTEGER,client_id TEXT,payload TEXT);CREATE TABLE settlements(client_id TEXT,payload TEXT);${dayInvoiceQueueSchema}`);
 db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(invoiceId,clientId,day,JSON.stringify(pre));db.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(invoiceId,1,JSON.stringify({version:1,invoice:pre,receipts:[]}));db.prepare('INSERT INTO sales VALUES(?,?,?)').run(1,clientId,JSON.stringify(sale));
 const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};return {db,tx};}
test('SQLite : source locale complète et validation de la facture du jour',async()=>{const {db,tx}=setup();try{const source=await readLocalDayInvoiceSource(tx,identity,clientId,day);assert.equal(validateDayInvoiceWrite(event,source).remaining,650000);assert.equal(source.preInvoice?.declared,false);}finally{db.close();}});
test('SQLite : une déclaration locale est reconnue pour le paiement suivant',async()=>{const {db,tx}=setup();try{await appendDayInvoicePayment(tx,event,identity,async()=>{});const source=await readLocalDayInvoiceSource(tx,identity,clientId,day);assert.equal(source.preInvoice?.declared,true);const next={...event,operationId:'22222222-2222-4222-8222-222222222222',amount:100000,preInvoice:{...event.preInvoice!,declare:false}};assert.equal(validateDayInvoiceWrite(next,source).remaining,550000);}finally{db.close();}});
test('SQLite : divergence des versions, règlements globaux non attribués et vente non synchronisable refusés',async()=>{const {db,tx}=setup();try{
 db.prepare('UPDATE journal_sync_state SET payload=?').run('{}');await assert.rejects(readLocalDayInvoiceSource(tx,identity,clientId,day),/incohérente/);
 db.prepare('UPDATE journal_sync_state SET payload=?').run(JSON.stringify({version:1,invoice:pre,receipts:[]}));db.prepare('INSERT INTO settlements VALUES(?,?)').run(clientId,JSON.stringify({createdAt:'2026-01-01T11:00:00.000Z'}));await assert.rejects(readLocalDayInvoiceSource(tx,identity,clientId,day),/non attribué/);
 db.exec('DELETE FROM settlements');db.prepare('UPDATE sales SET payload=?').run(JSON.stringify({...sale,syncSaleId:undefined}));await assert.rejects(readLocalDayInvoiceSource(tx,identity,clientId,day),/non synchronisable/);
 }finally{db.close();}});

test('SQLite : validation et enregistrement dans une même transaction, reprise sans double inscription',async()=>{
 const {writeLocalDayInvoicePayment}=await import('../../../apps/mobile/day-invoice-local.js');
 const {db,tx}=setup();try {
  db.exec('BEGIN');assert.equal(await writeLocalDayInvoicePayment(tx,identity,event,async()=>{}),'created');db.exec('COMMIT');
  db.exec('BEGIN');assert.equal(await writeLocalDayInvoicePayment(tx,identity,event,async()=>{}),'duplicate');db.exec('COMMIT');
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payments').get()?.n,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payment_outbox').get()?.n,1);
  const next={...event,operationId:'22222222-2222-4222-8222-222222222222',amount:650001,preInvoice:{...event.preInvoice!,declare:false}};
  db.exec('BEGIN');await assert.rejects(writeLocalDayInvoicePayment(tx,identity,next,async()=>{}),/supérieur/);db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payments').get()?.n,1);
 }finally{db.close();}
});

test('SQLite : ancienne dette réglée avec vente sur place reste non attribuable',async()=>{
 const {db,tx}=setup();try {
  const receipt={id:'11111111-1111-4111-8111-111111111112',preInvoiceId:invoiceId,clientId,journalDate:day,createdAt:'2026-01-01T11:00:00.000Z',prePaid:0,oldDebtPaid:50000,creditFull:true,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:100000};
  db.prepare('INSERT INTO tour_journal_receipts VALUES(?,?)').run(invoiceId,JSON.stringify(receipt));
  db.prepare('UPDATE journal_sync_state SET payload=?').run(JSON.stringify({version:1,invoice:pre,receipts:[receipt]}));
  await assert.rejects(readLocalDayInvoiceSource(tx,identity,clientId,day),/historique non attribué/);
  db.exec('DELETE FROM sales');
  const source=await readLocalDayInvoiceSource(tx,identity,clientId,day);
  assert.equal(source.preInvoice?.declared,true);
  assert.equal(source.preInvoice?.paid,0);
 }finally{db.close();}
});

test('SQLite : ancienne dette synchronisée admise seulement avec preuve locale exacte',async()=>{
 const {identifiedDeviceSchema}=await import('../../../apps/mobile/identified-device.js');
 const {creditReferencePrototypeSchema}=await import('../../../apps/mobile/credit-note-reference-cache-prototype.js');
 const {dayInvoiceReferenceCacheSchema}=await import('../../../apps/mobile/day-invoice-reference-cache.js');
 const {canonicalJson}=await import('../src/index.js');const {createHash}=await import('node:crypto');
 const digest=async(value:string)=>createHash('sha256').update(value).digest('hex');
 const {db,tx}=setup();try{
  db.exec(`${identifiedDeviceSchema}${creditReferencePrototypeSchema}${dayInvoiceReferenceCacheSchema}`);db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);
  const id='33333333-3333-4333-8333-333333333333',settlement={syncOperationId:id,createdAt:'2026-01-01T11:00:00.000Z',clientId,clientName:'Client',amount:10000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  const snapshot={version:6,clients:[{id:clientId,name:'Client',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'0'}],articles:[],saleStates:[],saleDays:[],settlementStates:[{operationId:id,clientId}],settlementDays:[{operationId:id,clientId,day}],settlementProofs:[{operationId:id,hash:await digest(canonicalJson(settlement))}],oldDebtMarkers:[{operationId:id,invoiceDay:day}],journalStates:[],journalProofs:[],dayPayments:[]};
  db.prepare('INSERT INTO day_invoice_reference_cache VALUES(1,?,?,?)').run(identity.commercialId,identity.serverOrigin,JSON.stringify(snapshot));db.prepare('INSERT INTO settlements VALUES(?,?)').run(clientId,JSON.stringify(settlement));
  assert.equal((await readLocalDayInvoiceSource(tx,identity,clientId,day,digest)).sales.length,1);
  await assert.rejects(readLocalDayInvoiceSource(tx,identity,clientId,day),/non attribué/);
  db.prepare('UPDATE settlements SET payload=?').run(JSON.stringify({...settlement,amount:20000}));await assert.rejects(readLocalDayInvoiceSource(tx,identity,clientId,day,digest),/Preuve de règlement/);
 }finally{db.close();}
});
