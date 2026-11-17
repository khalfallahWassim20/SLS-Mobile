import {dayInvoiceSaleAttemptSchema,prepareDaySaleAttempt} from '../../../apps/mobile/day-invoice-sale-attempt.js';
import {tourExpenseSchema} from '../../../apps/mobile/tour-expenses.js';
import {captureDayInvoiceJournalExport} from '../../../apps/mobile/day-invoice-journal-export.js';
import {journalHtml} from '../../../apps/mobile/journal-export.js';
import {readDayInvoiceClients} from '../../../apps/mobile/day-invoice-clients.js';
import {captureDayInvoiceTimeline} from '../../../apps/mobile/day-invoice-timeline.js';
import {test} from 'node:test';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema,prepareTourClose,prepareExperimentalDayInvoiceTourClose} from '../../../apps/mobile/tour-close-queue.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference} from '../../../apps/mobile/day-invoice-reference-cache.js';
import {dayInvoiceQueueSchema} from '../../../apps/mobile/day-invoice-queue.js';
import {dayInvoiceOldDebtAttemptSchema,readOldDebtAttempt,prepareOldDebtAttempt,confirmOldDebtAttempt,acknowledgeOldDebtAttempt,cancelOldDebtAttempt} from '../../../apps/mobile/day-invoice-old-debt-attempt.js';
import {assertDayInvoiceAttemptsSettled} from '../../../apps/mobile/day-invoice-attempt-guard.js';
import {synchronizeDayInvoicePrototype} from '../../../apps/mobile/day-invoice-sync.js';
import {captureOldDebtForm,confirmOldDebtForm} from '../../../apps/mobile/day-invoice-old-debt-form.js';
import {prepareOldDebtInput} from '../../../apps/mobile/day-invoice-old-debt-input.js';
import {captureDayInvoiceForm} from '../../../apps/mobile/day-invoice-form.js';
import {acknowledgeOldDebt,readOldDebtOutbox,type OldDebtEvent} from '../../../apps/mobile/day-invoice-old-debt-queue.js';
import {uploadOldDebts} from '../../../apps/mobile/day-invoice-old-debt-upload.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',saleId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',invoiceId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const identity={commercialId:clientId,serverOrigin:'https://example.test'},day='2026-01-01',at='2026-01-01T09:00:00.000Z';
const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');
function wrap(db:DatabaseSync){return {getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};}
function setup(path=':memory:'){const db=new DatabaseSync(path);db.exec(`PRAGMA foreign_keys=ON;${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}${dayInvoiceOldDebtAttemptSchema}${tourExpenseSchema}
 CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,created_at TEXT,client_id TEXT,payload TEXT);
 CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);
 CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);`);
 db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);
 const tx=wrap(db);return {db,tx};}
const reference={version:6,clientStatuses:[{clientId,active:true,statusRevision:'1'}],clients:[{id:clientId,name:'Client',sector:'Nord',openingBalance:'100000',creditLimit:'0',serverBalance:'350000'}],articles:[],saleStates:[{saleId,clientId,version:1,total:'250000',paid:'0'}],saleDays:[{saleId,clientId,day}],settlementStates:[],settlementDays:[],settlementProofs:[],journalStates:[{id:invoiceId,clientId,journalDate:day,total:600000,receipts:[],declaredByDayPayment:false}],journalProofs:[{id:invoiceId,version:1,hash:'a'.repeat(64)}],dayPayments:[]};
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

test('ancienne dette durable : redémarrage, atomicité, file acquittée et garde de clôture',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-old-debt-')),path=join(dir,'phone.db');let {db,tx}=setup(path);
 try{await saveDayInvoiceReference(tx,identity,identity,reference);
  const form=await captureOldDebtForm(tx,identity,clientId,day,digest),input={fingerprint:form.fingerprint,event:debt(id,60000)};
  await assert.rejects(prepareOldDebtAttempt(tx,identity,{...input,event:debt(id,100001)},digest),/supérieur/);
  await prepareOldDebtAttempt(tx,identity,input,digest);await assert.rejects(assertDayInvoiceAttemptsSettled(tx,identity),/Ancienne dette en attente/);await assertDayInvoiceAttemptsSettled(tx,identity,'2026-01-02');
  await assert.rejects(prepareOldDebtAttempt(tx,identity,{...input,event:debt(id2,1000)},digest),/autre règlement/);await assert.rejects(acknowledgeOldDebtAttempt(tx,identity,id),/non confirmé/);
  await cancelOldDebtAttempt(tx,identity,id);assert.equal(await readOldDebtAttempt(tx,identity),null);await prepareOldDebtAttempt(tx,identity,input,digest);
  db.close();db=new DatabaseSync(path);tx=wrap(db);assert.deepEqual((await readOldDebtAttempt(tx,identity))?.attempt,input);
  const failing={...tx,runAsync:async(sql:string,...args:(string|number|null)[])=>{if(sql.startsWith('UPDATE day_invoice_old_debt_attempt'))throw Error('panne avant reçu');await tx.runAsync(sql,...args);}};
  db.exec('BEGIN');await assert.rejects(confirmOldDebtAttempt(failing,identity,id,digest),/panne avant reçu/);db.exec('ROLLBACK');assert.equal(db.prepare('SELECT count(*) n FROM settlements').get()?.n,0);assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_old_debt_outbox').get()?.n,0);
  await assert.rejects(confirmOldDebtAttempt(tx,identity,id2,digest),/différente/);
  db.exec('BEGIN');assert.equal(await confirmOldDebtAttempt(tx,identity,id,digest),'created');db.exec('COMMIT');await assertDayInvoiceAttemptsSettled(tx,identity);
  db.close();db=new DatabaseSync(path);tx=wrap(db);assert.equal(await confirmOldDebtAttempt(tx,identity,id,digest),'duplicate');
  db.prepare('DELETE FROM day_invoice_old_debt_outbox').run();assert.equal(await confirmOldDebtAttempt(tx,identity,id,digest),'duplicate');assert.equal(db.prepare('SELECT count(*) n FROM settlements').get()?.n,1);
  await assert.rejects(cancelOldDebtAttempt(tx,identity,id),/abandonnable/);await assert.rejects(readOldDebtAttempt(tx,{...identity,serverOrigin:'https://other.test'}),/Identité/);
  const original=db.prepare('SELECT payload FROM day_invoice_old_debt_attempt').get()?.payload as string,tampered=JSON.parse(original);tampered.attempt.event.event.settlement.amount++;db.prepare('UPDATE day_invoice_old_debt_attempt SET payload=?').run(JSON.stringify(tampered));
  await assert.rejects(readOldDebtAttempt(tx,identity),/incohérente/);await assert.rejects(acknowledgeOldDebtAttempt(tx,identity,id),/incohérente/);
  db.prepare('UPDATE day_invoice_old_debt_attempt SET payload=?').run(original);await acknowledgeOldDebtAttempt(tx,identity,id);assert.equal(await readOldDebtAttempt(tx,identity),null);assert.equal(db.prepare('SELECT count(*) n FROM settlements').get()?.n,1);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('synchronisation ancienne dette : coupure ou référence sans preuve conserve la file, puis reprise atomique',async()=>{
 const {db,tx}=setup();try{
  const transaction=async<T>(fn:(t:typeof tx)=>Promise<T>)=>{db.exec('BEGIN');try{const value=await fn(tx);db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
  await transaction(t=>saveDayInvoiceReference(t,identity,identity,reference));const form=await captureOldDebtForm(tx,identity,clientId,day,digest),event=debt(id,60000);
  await transaction(t=>confirmOldDebtForm(t,identity,{fingerprint:form.fingerprint,event},digest));
  const {canonicalJson}=await import('@sls/domain');const hash=await digest(canonicalJson(event.event.settlement));
  const server={...reference,clients:[{...reference.clients[0],serverBalance:'290000'}],settlementStates:[{operationId:id,clientId}],settlementDays:[{operationId:id,clientId,day}],settlementProofs:[{operationId:id,hash}],oldDebtMarkers:[{operationId:id,invoiceDay:day}]};
  let calls=0,sends=0,mode:'cut'|'stale'|'ok'='cut';
  const io={transaction,digest,check:()=>{},verifyServer:async()=>{},fetchReference:async()=>{calls++;if(mode==='cut'&&calls===3)throw Error('référence interrompue');return mode==='ok'?server:reference;},sendSource:async()=>{throw Error('inattendu');},sendPayment:async()=>{throw Error('inattendu');},sendOldDebt:async()=>{sends++;return {ok:true,status:200,json:async()=>({status:sends===1?'received':'duplicate',operationId:id})};}};
  await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/référence interrompue/);assert.equal((await readOldDebtOutbox(tx,identity)).length,1);
  mode='stale';await assert.rejects(synchronizeDayInvoicePrototype(identity,identity,io),/Preuve serveur/);assert.equal((await readOldDebtOutbox(tx,identity)).length,1);
  mode='ok';assert.deepEqual(await synchronizeDayInvoicePrototype(identity,identity,io),{sources:1,payments:0,remainingSources:0,remainingPayments:0});assert.equal(sends,3);assert.equal((await readOldDebtOutbox(tx,identity)).length,0);
  assert.equal((await captureOldDebtForm(tx,identity,clientId,day,digest)).balance,290000);
 }finally{db.close();}
});


test('chronologie : ancienne dette distincte, preuve avant et après acquittement',async()=>{
 const {db,tx}=setup();try{
  await saveDayInvoiceReference(tx,identity,identity,reference);const form=await captureOldDebtForm(tx,identity,clientId,day,digest),event=debt(id,60000);
  await confirmOldDebtForm(tx,identity,{fingerprint:form.fingerprint,event},digest);
  let timeline=await captureDayInvoiceTimeline(tx,identity,clientId,digest);assert.equal(timeline.length,1);assert.equal(timeline[0].type==='settlement'&&timeline[0].oldDebt,true);
  const entry=(await readOldDebtOutbox(tx,identity))[0];await acknowledgeOldDebt(tx,identity,entry);
  await assert.rejects(captureDayInvoiceTimeline(tx,identity,clientId,digest),/Règlement en attente indisponible|Preuve ancienne dette/);
  const {canonicalJson}=await import('@sls/domain');const hash=await digest(canonicalJson(event.event.settlement));
  const server={...reference,clients:[{...reference.clients[0],serverBalance:'290000'}],settlementStates:[{operationId:id,clientId}],settlementDays:[{operationId:id,clientId,day}],settlementProofs:[{operationId:id,hash}],oldDebtMarkers:[{operationId:id,invoiceDay:day}]};
  await saveDayInvoiceReference(tx,identity,identity,server);timeline=await captureDayInvoiceTimeline(tx,identity,clientId,digest);assert.equal(timeline[0].type==='settlement'&&timeline[0].oldDebt,true);
  db.prepare('UPDATE day_invoice_reference_cache SET payload=?').run(JSON.stringify({...server,oldDebtMarkers:[]}));await assert.rejects(captureDayInvoiceTimeline(tx,identity,clientId,digest),/Preuve ancienne dette/);await assert.rejects(readDayInvoiceClients(tx,identity,digest),/Preuve ancienne dette/);db.prepare('UPDATE day_invoice_reference_cache SET payload=?').run(JSON.stringify(server));
  const original=db.prepare('SELECT payload FROM day_invoice_old_debt_local').get()?.payload as string;db.prepare('UPDATE day_invoice_old_debt_local SET payload=?').run(JSON.stringify({...event,event:{...event.event,settlement:{...event.event.settlement,amount:1}}}));
  await assert.rejects(captureDayInvoiceTimeline(tx,identity,clientId,digest),/Preuve ancienne dette/);db.prepare('UPDATE day_invoice_old_debt_local SET payload=?').run(original);
 }finally{db.close();}
});


test('export v6 : ancienne dette prouvée distincte de la facture du jour',async()=>{
 const {db,tx}=setup();try{
  await saveDayInvoiceReference(tx,identity,identity,reference);const form=await captureOldDebtForm(tx,identity,clientId,day,digest);
  await confirmOldDebtForm(tx,identity,{fingerprint:form.fingerprint,event:debt(id,60000)},digest);
  const data=await captureDayInvoiceJournalExport(tx,identity,day,'Commercial',digest);assert.equal(data.settlements?.length,1);assert.equal(data.dayInvoicePayments?.length,0);
  assert.match(journalHtml(data),/60,000/);assert.match(journalHtml(data),/ancienne dette/i);
  db.prepare('UPDATE settlements SET payload=?').run(JSON.stringify({...debt(id,60000).event.settlement,amount:61000}));await assert.rejects(captureDayInvoiceJournalExport(tx,identity,day,'Commercial',digest),/incohérent/);
 }finally{db.close();}
});


test('ancienne dette et vente : pas de seconde intention avant confirmation et reçu',async()=>{
 const {db,tx}=setup();try{
  db.exec(dayInvoiceSaleAttemptSchema);await saveDayInvoiceReference(tx,identity,identity,reference);
  const form=await captureOldDebtForm(tx,identity,clientId,day,digest),input={fingerprint:form.fingerprint,event:debt(id,60000)};
  const draft={clientId,day,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:1,discount:0,vat:0}],fingerprint:'aperçu',saleId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',operationId:id2,createdAt:at};
  await prepareOldDebtAttempt(tx,identity,input,digest);
  await assert.rejects(prepareDaySaleAttempt(tx,identity,draft,digest),/autre opération/);
  db.exec('BEGIN');await confirmOldDebtAttempt(tx,identity,id,digest);db.exec('COMMIT');
  await assert.rejects(prepareDaySaleAttempt(tx,identity,draft,digest),/autre opération/);
  await acknowledgeOldDebtAttempt(tx,identity,id);
  await assert.rejects(prepareDaySaleAttempt(tx,identity,draft,digest),/Règlement de dette en attente/);
 }finally{db.close();}
});
