import {test} from 'node:test';import assert from 'node:assert/strict';
import {replayDayInvoiceAdjustments,type AdjustmentEvent} from '../src/day-invoice-adjustment-ledger.js';
const opening={invoice:{preInvoice:{id:'pre',total:600000,paid:0,declared:true},sales:[{id:'sale',total:250000,paid:0}],dayPayments:[{id:'pay1',amount:800000}]},saleVersions:[{id:'sale',version:1}],balance:150000};
test('historique sans ventilation : crédit, hausse, règlement puis remboursement',()=>{
 const events:AdjustmentEvent[]=[
  {kind:'revision',operationId:'edit1',saleId:'sale',expectedVersion:1,newTotal:150000,choice:'credit',compensation:50000},
  {kind:'revision',operationId:'edit2',saleId:'sale',expectedVersion:2,newTotal:200000,choice:null,compensation:0},
  {kind:'payment',operationId:'pay2',amount:50000},
  {kind:'revision',operationId:'edit3',saleId:'sale',expectedVersion:3,newTotal:150000,choice:'refund',compensation:50000}
 ];
 const original=JSON.stringify({opening,events}),result=replayDayInvoiceAdjustments(opening,events);
 assert.deepEqual(result,{total:750000,applied:750000,remaining:0,balance:50000,refunds:50000,credits:50000,sales:[{id:'sale',total:150000,version:4}]});
 assert.equal(JSON.stringify({opening,events}),original);
});
test('pas de remboursement ou crédit implicite et pas de réutilisation de crédit',()=>{
 const credit:AdjustmentEvent={kind:'revision',operationId:'edit1',saleId:'sale',expectedVersion:1,newTotal:150000,choice:'credit',compensation:50000};
 const after=replayDayInvoiceAdjustments({...opening,balance:50000},[credit]);assert.equal(after.balance,-50000);assert.equal(after.remaining,0);
 const increase:AdjustmentEvent={kind:'revision',operationId:'edit2',saleId:'sale',expectedVersion:2,newTotal:200000,choice:null,compensation:0};
 const again=replayDayInvoiceAdjustments({...opening,balance:50000},[credit,increase]);assert.equal(again.balance,0);assert.equal(again.remaining,50000);assert.equal(again.credits,50000);
 assert.throws(()=>replayDayInvoiceAdjustments(opening,[{...credit,choice:null}]),/Compensation/);
 assert.throws(()=>replayDayInvoiceAdjustments(opening,[{...credit,compensation:49999}]),/Compensation/);
});
test('rejette doublon, mauvaise version, ordre et paiement excessif',()=>{
 const edit:AdjustmentEvent={kind:'revision',operationId:'edit',saleId:'sale',expectedVersion:1,newTotal:200000,choice:null,compensation:0};
 assert.throws(()=>replayDayInvoiceAdjustments(opening,[edit,edit]),/dupliquée/);
 assert.throws(()=>replayDayInvoiceAdjustments(opening,[{...edit,expectedVersion:2}]),/version/);
 assert.throws(()=>replayDayInvoiceAdjustments(opening,[{kind:'payment',operationId:'pay2',amount:50001}]),/supérieur/);
 assert.throws(()=>replayDayInvoiceAdjustments(opening,[{kind:'payment',operationId:'PAY1',amount:1}]),/dupliquée/);
 assert.throws(()=>replayDayInvoiceAdjustments(opening,[{...edit,choice:'refund'}]),/Compensation/);
 assert.throws(()=>replayDayInvoiceAdjustments({...opening,saleVersions:[]},[]),/version/i);
});
test('un millime et dépassement du solde sont contrôlés',()=>{
 const exact={invoice:{preInvoice:null,sales:[{id:'x',total:1001,paid:1001}],dayPayments:[]},saleVersions:[{id:'x',version:1}],balance:0};
 const edit:AdjustmentEvent={kind:'revision',operationId:'e',saleId:'x',expectedVersion:1,newTotal:1000,choice:'credit',compensation:1};
 assert.equal(replayDayInvoiceAdjustments(exact,[edit]).balance,-1);
 assert.throws(()=>replayDayInvoiceAdjustments({...exact,balance:Number.MIN_SAFE_INTEGER},[edit]),/trop élevé/);
});
