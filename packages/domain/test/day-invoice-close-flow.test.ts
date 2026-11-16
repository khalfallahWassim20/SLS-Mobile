import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema,assertLocalTourWritable,findTourCloseAttempt} from '../../../apps/mobile/tour-close-queue.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference} from '../../../apps/mobile/day-invoice-reference-cache.js';
import {dayInvoiceQueueSchema} from '../../../apps/mobile/day-invoice-queue.js';
import {tourExpenseSchema} from '../../../apps/mobile/tour-expenses.js';
import {dayInvoiceCloseAttemptSchema,acknowledgeDayInvoiceCloseAttempt,applyDayInvoiceReopenedState} from '../../../apps/mobile/day-invoice-close-attempt.js';
import {closeDayInvoicePrototype} from '../../../apps/mobile/day-invoice-close-flow.js';
const commercialId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',requestId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',day='2026-01-01';
const identity={commercialId,serverOrigin:'https://example.test'},digest=async(text:string)=>createHash('sha256').update(text).digest('hex');
function setup(){
 const db=new DatabaseSync(':memory:');db.exec(`${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}${tourExpenseSchema}${dayInvoiceCloseAttemptSchema}
 CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE sale_revisions(id INTEGER PRIMARY KEY,sale_id INTEGER,created_at TEXT,previous_payload TEXT,new_payload TEXT,refund INTEGER);
 CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);
 CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);`);
 db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(commercialId,identity.serverOrigin);
 const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};
 const transaction=async<T>(fn:(t:typeof tx)=>Promise<T>)=>{db.exec('BEGIN');try{const value=await fn(tx);db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
 return {db,tx,transaction};
}
const ref={version:6,clients:[],articles:[],saleStates:[],saleDays:[],settlementStates:[],settlementDays:[],settlementProofs:[],oldDebtMarkers:[],journalStates:[],journalProofs:[],dayPayments:[]};
test('clôture v6 : réponse perdue, accusé altéré, même preuve, puis réouverture admin',async()=>{
 const {db,tx,transaction}=setup();try{
  await transaction(t=>saveDayInvoiceReference(t,identity,identity,ref));let calls=0,observations=0,invalid=true;const payloads:string[]=[];
  const io={transaction,digest,uuid:()=>requestId,check:()=>{},verifyServer:async()=>{},readDay:async()=>{observations++;return {ok:true,status:200,json:async()=>({commercialId,day,status:'open',version:0})};},sendClose:async(payload:string)=>{payloads.push(payload);calls++;if(calls===1)throw Error('réponse perdue');return {ok:true,status:200,json:async()=>({status:'duplicate',requestId:invalid?'autre':requestId,commercialId,day,action:'close',version:1})};}};
  await assert.rejects(closeDayInvoicePrototype(identity,day,io),/réponse perdue/);assert.equal((await findTourCloseAttempt(tx,commercialId,day))?.status,'closing');await assert.rejects(assertLocalTourWritable(tx,commercialId,day),/attente/);
  await assert.rejects(closeDayInvoicePrototype(identity,day,io),/Accusé/);assert.equal((await findTourCloseAttempt(tx,commercialId,day))?.status,'closing');assert.equal(payloads[0],payloads[1]);assert.equal(observations,1);
  invalid=false;assert.deepEqual(await closeDayInvoicePrototype(identity,day,io),{day,version:1});assert.equal(payloads[1],payloads[2]);assert.equal((await findTourCloseAttempt(tx,commercialId,day))?.status,'closed');
  await assert.rejects(closeDayInvoicePrototype(identity,day,io),/déjà clôturée/);await assert.rejects(assertLocalTourWritable(tx,commercialId,day),/clôturée/);
  await transaction(t=>applyDayInvoiceReopenedState(t,identity,day,{commercialId,day,status:'open',version:2}));assert.equal(await findTourCloseAttempt(tx,commercialId,day),null);assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_close_attempt_markers').get()?.n,0);
 }finally{db.close();}
});
test('clôture v6 : identité, référence et marqueur contrôlés avant tout acquittement',async()=>{
 const {db,tx,transaction}=setup();try{
  const io={transaction,digest,uuid:()=>requestId,check:()=>{},verifyServer:async()=>{},readDay:async()=>({ok:true,status:200,json:async()=>({commercialId,day,status:'open',version:0})}),sendClose:async()=>{throw Error('ne doit pas envoyer');}};
  await assert.rejects(closeDayInvoicePrototype(identity,day,io),/Référence facture/);assert.equal(await findTourCloseAttempt(tx,commercialId,day),null);
  await transaction(t=>saveDayInvoiceReference(t,identity,identity,ref));await assert.rejects(closeDayInvoicePrototype(identity,day,io),/ne doit pas envoyer/);
  const attempt=(await findTourCloseAttempt(tx,commercialId,day))!,receipt={status:'duplicate',requestId,commercialId,day,action:'close',version:1};
  db.prepare('UPDATE day_invoice_close_attempt_markers SET cash_proof=?').run('a'.repeat(64));await assert.rejects(transaction(t=>acknowledgeDayInvoiceCloseAttempt(t,identity,day,attempt,receipt)),/Preuve/);
  assert.equal((await findTourCloseAttempt(tx,commercialId,day))?.status,'closing');
  await assert.rejects(transaction(t=>acknowledgeDayInvoiceCloseAttempt(t,{...identity,serverOrigin:'https://autre.test'},day,attempt,receipt)),/Identité/);
 }finally{db.close();}
});

test('clôture v6 : une fermeture concurrente est bloquée et le verrou est libéré',async()=>{
 const {db,transaction}=setup();try{
  await transaction(t=>saveDayInvoiceReference(t,identity,identity,ref));let resume!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{resume=r;});
  const io={transaction,digest,uuid:()=>requestId,check:()=>{},verifyServer:async()=>{entered();await wait;},readDay:async()=>({ok:true,status:200,json:async()=>({commercialId,day,status:'open',version:0})}),sendClose:async()=>({ok:true,status:201,json:async()=>({status:'received',requestId,commercialId,day,action:'close',version:1})})};
  const first=closeDayInvoicePrototype(identity,day,io);await started;await assert.rejects(closeDayInvoicePrototype(identity,day,io),/déjà en cours/);resume();assert.deepEqual(await first,{day,version:1});
  await assert.rejects(closeDayInvoicePrototype(identity,day,io),/déjà clôturée/);
 }finally{db.close();}
});
