import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference} from '../../../apps/mobile/day-invoice-reference-cache.js';
import {dayInvoiceQueueSchema,appendDayInvoicePayment} from '../../../apps/mobile/day-invoice-queue.js';
import {readDayInvoiceClients} from '../../../apps/mobile/day-invoice-clients.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',saleId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',invoiceId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const identity={commercialId:clientId,serverOrigin:'https://example.test'},day='2026-01-01',at='2026-01-01T09:00:00.000Z';
const saleOperation='11111111-1111-4111-8111-111111111111',journalOperation='22222222-2222-4222-8222-222222222222',paymentOperation='33333333-3333-4333-8333-333333333333';
const sale={createdAt:at,clientId,clientName:'Client',syncSaleId:saleId,syncVersion:1,total:250000,paid:0,remaining:250000,paymentMode:'Crédit',lines:[],chequeNumber:'',chequeBank:'',chequeDue:''};
const invoice={id:invoiceId,clientId,clientName:'Client',journalDate:day,sector:'Nord',amount:600000,createdAt:at};
const payment={operationId:paymentOperation,clientId,day,recordedAt:'2026-01-01T10:00:00.000Z',amount:200000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]};
const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');
function setup(){const db=new DatabaseSync(':memory:');db.exec(`${identifiedDeviceSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}
 CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
 CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);
 CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);`);
 db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);
 const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};return {db,tx};}
test('soldes v6 : opérations hors ligne, déclaration unique, limite et reprise',async()=>{
 const {db,tx}=setup();try{
  const reference={version:6,clients:[{id:clientId,name:'Client',sector:'Nord',openingBalance:'0',creditLimit:'600000',serverBalance:'0'}],articles:[],saleStates:[],saleDays:[],settlementStates:[],settlementDays:[],settlementProofs:[],journalStates:[],journalProofs:[],dayPayments:[]};await saveDayInvoiceReference(tx,identity,identity,reference);
  const se={operationId:saleOperation,saleId,version:1,sale,refund:0},je={operationId:journalOperation,version:1,invoice,receipts:[]};
  db.prepare('INSERT INTO sales VALUES(1,?,?)').run(clientId,JSON.stringify(sale));db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(invoiceId,clientId,day,JSON.stringify(invoice));db.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(invoiceId,1,JSON.stringify(je));
  const marker=db.prepare('INSERT INTO identified_local_operations(operation_id,commercial_id,operation_kind,entity_id,recorded_at) VALUES(?,?,?,?,?)');marker.run(saleOperation,clientId,'sale',saleId,at);marker.run(journalOperation,clientId,'journal',invoiceId,at);
  db.prepare('INSERT INTO sales_outbox VALUES(1,?,?,?)').run(saleOperation,saleId,JSON.stringify(se));db.prepare('INSERT INTO journal_sync_outbox VALUES(1,?,?,?)').run(journalOperation,invoiceId,JSON.stringify(je));
  await appendDayInvoicePayment(tx,payment,identity,async()=>{});
  const snapshot=await readDayInvoiceClients(tx,identity,digest),c=snapshot.clients[0];assert.equal(c.balance,650000);assert.equal(c.pendingDayPayments,200000);assert.equal(c.saleBlocked,true);assert.equal(snapshot.pendingOperations,3);
  db.prepare('UPDATE sales SET payload=?').run(JSON.stringify({...sale,total:249000}));await assert.rejects(readDayInvoiceClients(tx,identity,digest),/Version de vente en attente/);
  assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payment_outbox').get()?.n,1);
 }finally{db.close();}
});
test('soldes v6 : une identité ou une facture orpheline ne peut produire un solde',async()=>{
 const {db,tx}=setup();try{
  const reference={version:6,clients:[{id:clientId,name:'Client',sector:'Nord',openingBalance:'0',creditLimit:'0',serverBalance:'0'}],articles:[],saleStates:[],saleDays:[],settlementStates:[],settlementDays:[],settlementProofs:[],journalStates:[],journalProofs:[],dayPayments:[]};await saveDayInvoiceReference(tx,identity,identity,reference);
  assert.equal((await readDayInvoiceClients(tx,identity,digest)).clients[0].saleBlocked,false);
  db.prepare('INSERT INTO tour_journal_receipts VALUES(?,?,?,?,?)').run('x',invoiceId,clientId,day,'{}');await assert.rejects(readDayInvoiceClients(tx,identity,digest),/sans facture/);
  db.exec('DELETE FROM tour_journal_receipts');await assert.rejects(readDayInvoiceClients(tx,{...identity,serverOrigin:'https://other.test'},digest),/Identité/);
 }finally{db.close();}
});
