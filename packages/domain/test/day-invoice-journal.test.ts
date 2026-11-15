import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {readDayInvoiceJournalPayments} from '../../../apps/api/src/day-invoice-journal.js';
import {dayInvoicePaymentHash} from '../../../apps/api/src/day-invoice-protocol.js';

test('journal unifié : date tunisienne d’encaissement, intégrité et absence du registre',async()=>{
 const clientId=randomUUID(),commercialId=randomUUID(),invoiceId=randomUUID();
 const p={operationId:randomUUID(),clientId,day:'2026-01-01',recordedAt:'2026-01-01T23:30:00.000Z',amount:125000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[]};
 const row={operation_id:p.operationId,client_id:clientId,invoice_day:p.day,event_day:'2026-01-02',payload:p,payload_hash:dayInvoicePaymentHash(p),name:'Client',sector:''};
 let present=true;let resultRows=[row];let args:unknown[]=[];
 const db={query:async(sql:string,params?:unknown[])=>{if(sql.includes('to_regclass'))return {rows:[{present}]};args=params??[];return {rows:resultRows};}} as unknown as PoolClient;
 const result=await readDayInvoiceJournalPayments(db,commercialId,'2026-01-02');
 assert.deepEqual(args,[commercialId,'2026-01-02']);assert.equal(result.total,125000);assert.equal(result.payments[0].invoiceDay,'2026-01-01');assert.equal(result.payments[0].declaresInvoice,true);
 resultRows=[{...row,payload_hash:'incorrect'}];await assert.rejects(readDayInvoiceJournalPayments(db,commercialId,'2026-01-02'),/incohérent/);
 resultRows=[{...row,event_day:'2026-01-01'}];await assert.rejects(readDayInvoiceJournalPayments(db,commercialId,'2026-01-02'),/incohérent/);
 present=false;assert.deepEqual(await readDayInvoiceJournalPayments(db,commercialId,'2026-01-02'),{payments:[],total:0});
});
