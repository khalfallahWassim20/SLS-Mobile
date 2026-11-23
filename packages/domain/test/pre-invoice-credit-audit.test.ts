import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {auditStoredPreInvoiceCreditNotes} from '../../../apps/api/src/credit-note-audit-read.js';
import {auditPreInvoiceCreditNotes,type PreInvoiceCreditEventRecord} from '../src/credit-note-audit.ts';
import {calculatePreInvoiceCancellation} from '../src/pre-invoice-credit-note.ts';
const clientId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
type Receipt={prePaid:number;oldDebtPaid:number;creditFull:boolean;createdAt:string};
const make=(n:number,amount:number,receipts:Receipt[],choice:'refund'|'credit'|null)=>{
 const hex=String(n).padStart(12,'0'),command={operationId:`bbbbbbbb-bbbb-4bbb-8bbb-${hex}`,invoiceId:`cccccccc-cccc-4ccc-8ccc-${hex}`,recordedAt:'2026-01-01T12:00:00.000Z',choice};
 const calc=calculatePreInvoiceCancellation({balance:0,invoiceTotal:amount,receipts,alreadyCancelled:false,choice:choice??undefined});
 const event={command,source:{invoice:{id:command.invoiceId,clientId,amount,createdAt:'2026-01-01T08:00:00.000Z'},receipts},clientId,...calc} as PreInvoiceCreditEventRecord;
 const m=[{operationId:command.operationId,kind:'invoice_cancellation',delta:String(calc.wasDeclared?-amount:0)},...(calc.refund>0?[{operationId:command.operationId,kind:'refund',delta:String(calc.refund)}]:[])];
 return {event,m};
};
const r=(prePaid:number,oldDebtPaid=0,creditFull=false):Receipt=>({prePaid,oldDebtPaid,creditFull,createdAt:'2026-01-01T09:00:00.000Z'});
test('audit des préétablies : remboursement, crédit, impayée et ancienne dette séparée',()=>{
 const a=make(1,500000,[r(500000)],'refund'),b=make(2,500000,[r(200000)],'credit'),c=make(3,500000,[],null),d=make(4,500000,[r(200000,100000)],'refund'),e=make(5,500000,[r(0,0,true)],null);
 assert.equal(d.event.refund,200000);
 assert.deepEqual(auditPreInvoiceCreditNotes([a,b,c,d,e].map(x=>x.event),[a,b,c,d,e].flatMap(x=>x.m)),{checked:5,issues:[]});
});
test('audit des préétablies : anomalies signalées',()=>{
 const a=make(1,500000,[r(200000,100000)],'refund');
 const codes=(events:PreInvoiceCreditEventRecord[],m:{operationId:string;kind:string;delta:string}[])=>auditPreInvoiceCreditNotes(events,m).issues.map(i=>i.code);
 assert.ok(codes([{...a.event,refund:300000}],a.m).includes('EVENT_RECOMPUTE_MISMATCH'));
 assert.ok(codes([a.event],a.m.map(m=>m.kind==='refund'?{...m,delta:'300000'}:m)).includes('REFUND_MOVEMENT_WRONG'));
 assert.ok(codes([a.event],a.m.map(m=>m.kind==='invoice_cancellation'?{...m,delta:'0'}:m)).includes('CANCELLATION_MOVEMENT_WRONG'));
 assert.ok(codes([a.event],a.m.filter(m=>m.kind!=='refund')).includes('REFUND_MOVEMENT_WRONG'));
 assert.ok(codes([{...a.event,command:{...a.event.command,recordedAt:'2026-01-01T08:30:00.000Z'}}],a.m).includes('NOTE_BEFORE_PAYMENT'));
 assert.ok(codes([{...a.event,clientId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}],a.m).includes('IDENTITY_MISMATCH'));
 assert.ok(codes([a.event],[]).includes('CANCELLATION_MOVEMENT_WRONG'));
 assert.ok(codes([],a.m).includes('MOVEMENT_WITHOUT_EVENT'));
});
test('audit des préétablies : lecture SQL réelle',async()=>{
 const db=new PGlite();
 try{
  await db.exec(schemaSql);const a=make(1,500000,[r(200000,100000)],'refund');
  await db.query('INSERT INTO credit_note_prototype_operation_ids(operation_id) VALUES($1)',[a.event.command.operationId]);
  await db.query('INSERT INTO pre_invoice_credit_prototype_events(operation_id,invoice_id,event) VALUES($1,$2,$3)',[a.event.command.operationId,a.event.command.invoiceId,JSON.stringify(a.event)]);
  for(const m of a.m)await db.query('INSERT INTO pre_invoice_credit_prototype_movements(operation_id,kind,balance_delta) VALUES($1,$2,$3)',[m.operationId,m.kind,m.delta]);
  assert.deepEqual(await auditStoredPreInvoiceCreditNotes(db),{checked:1,issues:[]});
  await db.query("UPDATE pre_invoice_credit_prototype_movements SET balance_delta=300000 WHERE kind='refund'");
  assert.ok((await auditStoredPreInvoiceCreditNotes(db)).issues.some(i=>i.code==='REFUND_MOVEMENT_WRONG'));
 }finally{await db.close();}
});
