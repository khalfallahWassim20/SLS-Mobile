import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {compareDayInvoiceCash,dayInvoiceCashClosureCanonical} from '../src/day-invoice-cash.js';
import {readLocalDayInvoiceCash} from '../../../apps/mobile/day-invoice-cash.js';
import {dayInvoiceQueueSchema} from '../../../apps/mobile/day-invoice-queue.js';
const commercialId=randomUUID(),clientId=randomUUID(),day='2026-01-02',identity={commercialId,serverOrigin:'http://example.test'};
const event={operationId:randomUUID(),clientId,day:'2026-01-01',recordedAt:'2026-01-01T23:30:00.000Z',amount:125000,mode:'Chèque' as const,chequeNumber:'123',chequeBank:'Banque',chequeDue:'2026-02-01',preInvoice:{id:randomUUID(),version:1,total:600000,declare:true},sales:[]};
const journal={version:5,commercialId,day,events:[]},sales={version:5,commercialId,day,initialEvents:[],refundEvents:[],saleStates:[]};
test('preuve de caisse v6 : ordre, identité d’opération, contenu complet et date tunisienne',()=>{
 const second={...event,operationId:randomUUID(),amount:5000,preInvoice:{...event.preInvoice,declare:false}};
 const proof=dayInvoiceCashClosureCanonical(sales,journal,[event,second],commercialId,day,[]);
 assert.equal(proof,dayInvoiceCashClosureCanonical(sales,journal,[second,event],commercialId,day,[]));
 assert.notEqual(proof,dayInvoiceCashClosureCanonical(sales,journal,[event,{...second,amount:6000}],commercialId,day,[]));
 assert.throws(()=>compareDayInvoiceCash([],[],'2026-02-30'),/Date/);
 assert.equal(compareDayInvoiceCash([event,second],[event],day).onlyLocal,1);
 assert.equal(compareDayInvoiceCash([event],[{...event,chequeNumber:'456'}],day).changed,1);
 assert.throws(()=>dayInvoiceCashClosureCanonical(sales,journal,[event,event],commercialId,day,[]),/dupliqué/);
 assert.throws(()=>dayInvoiceCashClosureCanonical({...sales,day:'2026-01-01'},{...journal,day:'2026-01-01'},[event],commercialId,'2026-01-01',[]),/journée/);
 const collision={...journal,events:[{kind:'settlement',operationId:event.operationId,clientId,recordedAt:event.recordedAt,amount:1,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}]};
 assert.throws(()=>dayInvoiceCashClosureCanonical(sales,collision,[event],commercialId,day,[]),/dupliqué/);
 assert.throws(()=>dayInvoiceCashClosureCanonical(sales,journal,[{...event,chequeBank:''}],commercialId,day,[]),/chèque/i);
});
test('déclaration propriétaire distincte de la caisse et vérifiée intégralement',()=>{
 const invoiceDay='2026-01-01',recorded='2026-01-02T10:00:00.000Z';
 const declaration={...event,day:invoiceDay,recordedAt:recorded};
 const inv={kind:'invoice',operationId:randomUUID(),invoiceId:declaration.preInvoice.id,clientId,recordedAt:'2026-01-01T10:00:00.000Z',amount:600000};
 const j={...journal,day:invoiceDay,events:[inv]},s={...sales,day:invoiceDay};
 const proof=dayInvoiceCashClosureCanonical(s,j,[],commercialId,invoiceDay,[declaration]);
 assert.notEqual(proof,dayInvoiceCashClosureCanonical(s,j,[],commercialId,invoiceDay,[]));
 assert.throws(()=>dayInvoiceCashClosureCanonical(s,j,[],commercialId,invoiceDay,[declaration,declaration]),/dupliquée/);
 assert.throws(()=>dayInvoiceCashClosureCanonical(s,j,[],commercialId,invoiceDay,[{...declaration,preInvoice:{...declaration.preInvoice,total:1}}]),/incohérente/);
 assert.throws(()=>dayInvoiceCashClosureCanonical(s,j,[],commercialId,invoiceDay,[{...declaration,clientId:randomUUID()}]),/incohérente/);
 const sameDay={...declaration,recordedAt:inv.recordedAt};
 assert.doesNotThrow(()=>dayInvoiceCashClosureCanonical(s,j,[sameDay],commercialId,invoiceDay,[sameDay]));
 assert.throws(()=>dayInvoiceCashClosureCanonical(s,j,[sameDay],commercialId,invoiceDay,[{...sameDay,amount:1}]),/divergente/);
});
test('capture SQLite : identité, conservation après accusé et données corrompues',async()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(dayInvoiceQueueSchema);db.prepare('INSERT INTO day_invoice_payments(operation_id,client_id,invoice_day,payload,commercial_id,server_origin) VALUES(?,?,?,?,?,?)').run(event.operationId,clientId,event.day,JSON.stringify(event),commercialId,identity.serverOrigin);
  const tx={getAllAsync:async <T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[]};
  assert.deepEqual(await readLocalDayInvoiceCash(tx,identity,day),[event]);assert.deepEqual(await readLocalDayInvoiceCash(tx,identity,'2026-01-01'),[]);
  await assert.rejects(readLocalDayInvoiceCash(tx,{...identity,serverOrigin:'http://other.test'},day),/autre commercial ou serveur/);
  db.prepare('UPDATE day_invoice_payments SET client_id=?').run(randomUUID());await assert.rejects(readLocalDayInvoiceCash(tx,identity,day),/incohérent/);
 }finally{db.close();}
});
