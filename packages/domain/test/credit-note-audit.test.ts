import {test} from 'node:test';
import assert from 'node:assert/strict';
import {auditCreditNotes} from '../src/credit-note-audit.ts';
import {prepareFullCreditNote} from '../src/credit-note-command.ts';
const actor={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',role:'commercial' as const};
const make=(n:number,total:number,netPaid:number,choice:'refund'|'credit'|null)=>{
 const hex=String(n).padStart(12,'0'),command={operationId:`bbbbbbbb-bbbb-4bbb-8bbb-${hex}`,invoiceId:`cccccccc-cccc-4ccc-8ccc-${hex}`,expectedVersion:1,recordedAt:'2026-01-01T10:00:00.000Z',choice};
 const event=prepareFullCreditNote({actor,command,source:{invoiceId:command.invoiceId,version:1,total,netPaid,cancelled:false},daysOpen:true,previous:null}).event;
 const m=[{operationId:command.operationId,kind:'invoice_cancellation',delta:String(-event.noteTotal)},...(event.refund>0?[{operationId:command.operationId,kind:'refund',delta:String(event.refund)}]:[])];
 return {event,m};
};
test('audit des avoirs : remboursement, crédit client et facture impayée sont cohérents',()=>{
 const a=make(1,300000,300000,'refund'),b=make(2,300000,100000,'credit'),c=make(3,50000,0,null);
 assert.deepEqual(auditCreditNotes([a.event,b.event,c.event],[...a.m,...b.m,...c.m]),{checked:3,issues:[]});
});
test('audit des avoirs : mouvements manquants, faux ou orphelins sont signalés',()=>{
 const a=make(1,300000,300000,'refund'),b=make(2,300000,100000,'credit');
 const codes=(events:typeof a.event[],m:{operationId:string;kind:string;delta:string}[])=>auditCreditNotes(events,m).issues.map(i=>i.code);
 assert.ok(codes([a.event],a.m.filter(m=>m.kind!=='refund')).includes('REFUND_MOVEMENT_WRONG'));
 assert.ok(codes([a.event],a.m.map(m=>m.kind==='refund'?{...m,delta:'299999'}:m)).includes('BALANCE_DELTA_MISMATCH'));
 assert.ok(codes([b.event],[...b.m,{operationId:b.event.command.operationId,kind:'refund',delta:'100000'}]).includes('REFUND_MOVEMENT_UNEXPECTED'));
 assert.ok(codes([a.event],[]).includes('CANCELLATION_MOVEMENT_WRONG'));
 assert.ok(codes([a.event],[...a.m,...b.m]).includes('MOVEMENT_WITHOUT_EVENT'));
 assert.ok(codes([{...a.event,refund:1}],a.m).includes('EVENT_RECOMPUTE_MISMATCH'));
 assert.ok(codes([a.event,{...b.event,command:{...b.event.command,invoiceId:a.event.command.invoiceId}}],[...a.m,...b.m]).includes('INVOICE_CANCELLED_TWICE'));
 assert.ok(codes([a.event,a.event],a.m).includes('OPERATION_DUPLICATED'));
});
