import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prepareFullCreditNote} from '../src/index.js';
import {projectPrototypeCreditNotes} from '../../../apps/api/src/credit-note-projection-prototype.js';

function fixture(total:number,paid:number,choice:'refund'|'credit'|null,balance:number){
 const invoiceId=randomUUID(),clientId=randomUUID(),operationId=randomUUID(),actor={id:randomUUID(),role:'commercial' as const};
 const command={operationId,invoiceId,expectedVersion:1,recordedAt:'2026-11-08T10:00:00.000Z',choice};
 const source={invoiceId,version:1,total,netPaid:paid,cancelled:false};
 const event=prepareFullCreditNote({actor,command,source,daysOpen:true,previous:null}).event;
 return {balances:[{clientId,balance}],sales:[{invoiceId,clientId,version:1,total,netPaid:paid}],events:[event],movements:[{operationId,kind:'invoice_cancellation' as const,balanceDelta:-total},...(event.refund?[{operationId,kind:'refund' as const,balanceDelta:event.refund}]:[])]};
}
test('projection expérimentale : impayé, remboursement, crédit conservé et trop-perçu',()=>{
 for(const [total,paid,choice,start,end] of [[600000,0,null,600000,0],[600000,200000,'refund',400000,0],[600000,200000,'credit',400000,-200000],[600000,800000,'credit',-200000,-800000],[600000,800000,'refund',-200000,0]] as const){
  const f=fixture(total,paid,choice,start);assert.equal(projectPrototypeCreditNotes(f.balances,f.sales,f.events,f.movements)[0].balance,end);
 }
});
test('projection refuse mouvements absents, doublés ou altérés et vente modifiée',()=>{
 const f=fixture(600000,200000,'refund',400000);
 assert.throws(()=>projectPrototypeCreditNotes(f.balances,f.sales,f.events,f.movements.slice(0,1)),/manquant/);
 assert.throws(()=>projectPrototypeCreditNotes(f.balances,f.sales,f.events,[...f.movements,f.movements[0]]),/incohérent/);
 assert.throws(()=>projectPrototypeCreditNotes(f.balances,f.sales,f.events,[f.movements[0],{...f.movements[1],balanceDelta:1}]),/incohérent/);
 assert.throws(()=>projectPrototypeCreditNotes(f.balances,[{...f.sales[0],version:2}],f.events,f.movements),/version/);
 assert.throws(()=>projectPrototypeCreditNotes(f.balances,f.sales,[{...f.events[0],balanceDelta:0}],f.movements),/incohérents/);
 assert.throws(()=>projectPrototypeCreditNotes([{...f.balances[0],balance:Number.MIN_SAFE_INTEGER}],f.sales,f.events,f.movements),/trop élevé/);
});
