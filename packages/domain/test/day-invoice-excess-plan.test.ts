import {test} from 'node:test';import assert from 'node:assert/strict';
import {planDayInvoiceSaleExcess,selectDayInvoiceExcessPlan} from '../src/day-invoice-excess-plan.js';
const invoice={preInvoice:{id:'pre',total:600000,paid:0,declared:true},sales:[{id:'sale',total:250000,paid:0}],dayPayments:[{id:'payment',amount:800000}]};
test('baisse après paiement unique : remboursement ou crédit, sans ventilation',()=>{
 const plan=planDayInvoiceSaleExcess(invoice,'sale',150000,150000);
 assert.equal(plan.previousTotal,850000);assert.equal(plan.total,750000);assert.equal(plan.paid,800000);assert.equal(plan.excess,50000);assert.equal(plan.remaining,0);
 assert.deepEqual(plan.options,[{choice:'refund',refundAmount:50000,creditAmount:0,balanceAfter:100000},{choice:'credit',refundAmount:0,creditAmount:50000,balanceAfter:50000}]);
 assert.equal(selectDayInvoiceExcessPlan(invoice,'sale',150000,150000,'credit').selected.balanceAfter,50000);
 assert.throws(()=>selectDayInvoiceExcessPlan(invoice,'sale',150000,150000,null),/Choix/);
});
test('crédit client et absence de trop-perçu tiennent compte du solde global',()=>{
 assert.equal(selectDayInvoiceExcessPlan(invoice,'sale',150000,50000,'credit').selected.balanceAfter,-50000);
 assert.equal(selectDayInvoiceExcessPlan(invoice,'sale',150000,50000,'refund').selected.balanceAfter,0);
 const normal=selectDayInvoiceExcessPlan(invoice,'sale',300000,50000,null);
 assert.equal(normal.total,900000);assert.equal(normal.remaining,100000);assert.deepEqual(normal.selected,{choice:null,refundAmount:0,creditAmount:0,balanceAfter:100000});
 assert.throws(()=>selectDayInvoiceExcessPlan(invoice,'sale',300000,50000,'refund'),/Choix/);
});
test('refuse les historiques déjà surpayés, les données invalides et le dépassement numérique',()=>{
 const historical={preInvoice:null,sales:[{id:'sale',total:10,paid:11}],dayPayments:[]};
 assert.throws(()=>planDayInvoiceSaleExcess(historical,'sale',10,0),/déjà surpayée/);
 assert.throws(()=>planDayInvoiceSaleExcess(invoice,'missing',100,0),/indisponible/);
 assert.throws(()=>planDayInvoiceSaleExcess(invoice,'sale',-1,0),/Montant invalide/);
 assert.throws(()=>planDayInvoiceSaleExcess(invoice,'sale',300000,Number.MAX_SAFE_INTEGER),/Solde trop élevé/);
 assert.throws(()=>planDayInvoiceSaleExcess(invoice,'sale',150000,0.5),/Solde client invalide/);
});

test('millime exact et données inchangées après simulation',()=>{
 const input={preInvoice:null,sales:[{id:'sale',total:1001,paid:0}],dayPayments:[{id:'p',amount:1001}]};
 const original=JSON.stringify(input),plan=planDayInvoiceSaleExcess(input,'sale',1000,0);
 assert.equal(plan.excess,1);assert.deepEqual(plan.options,[{choice:'refund',refundAmount:1,creditAmount:0,balanceAfter:0},{choice:'credit',refundAmount:0,creditAmount:1,balanceAfter:-1}]);
 assert.equal(JSON.stringify(input),original);
});
