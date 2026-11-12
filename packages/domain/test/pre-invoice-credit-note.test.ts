import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculatePreInvoiceCancellation} from '../src/pre-invoice-credit-note.js';
const receipt=(prePaid:number,oldDebtPaid:number,creditFull=false)=>({prePaid,oldDebtPaid,creditFull});

test('préétablie : choix de crédit total ou facture pas encore déclarée',()=>{
 const untouched=calculatePreInvoiceCancellation({balance:1000000,invoiceTotal:600000,receipts:[],alreadyCancelled:false});
 assert.equal(untouched.creditNoteTotal,600000);assert.equal(untouched.balanceDelta,0);assert.equal(untouched.balanceAfter,1000000);assert.equal(untouched.wasDeclared,false);
 const unpaid=calculatePreInvoiceCancellation({balance:1600000,invoiceTotal:600000,receipts:[receipt(0,0,true)],alreadyCancelled:false});
 assert.equal(unpaid.balanceAfter,1000000);assert.equal(unpaid.refund,0);assert.equal(unpaid.retainedCredit,0);
});
test('préétablie : rembourse uniquement ses paiements, conserve le règlement de dette ancienne',()=>{
 // Dette initiale 1000, facture 600, payée 250, ancienne dette réglée 400 : solde 950.
 const base={balance:950000,invoiceTotal:600000,receipts:[receipt(200000,300000),receipt(50000,100000)],alreadyCancelled:false};
 const refund=calculatePreInvoiceCancellation({...base,choice:'refund'});
 assert.equal(refund.refund,250000);assert.equal(refund.oldDebtPaid,400000);assert.equal(refund.balanceAfter,600000);
 const credit=calculatePreInvoiceCancellation({...base,choice:'credit'});
 assert.equal(credit.retainedCredit,250000);assert.equal(credit.oldDebtPaid,400000);assert.equal(credit.balanceAfter,350000);
});
test('préétablie réglée : remboursement intégral ou crédit, sans toucher à la dette ancienne',()=>{
 const base={balance:600000,invoiceTotal:600000,receipts:[receipt(600000,400000)],alreadyCancelled:false};
 assert.equal(calculatePreInvoiceCancellation({...base,choice:'refund'}).balanceAfter,600000);
 assert.equal(calculatePreInvoiceCancellation({...base,choice:'credit'}).balanceAfter,0);
});
test('préétablie : rejette choix absents ou incohérents, double avoir et valeurs invalides',()=>{
 const base={balance:0,invoiceTotal:1000,receipts:[receipt(500,0)],alreadyCancelled:false};
 assert.throws(()=>calculatePreInvoiceCancellation(base),/Choisissez/);
 assert.throws(()=>calculatePreInvoiceCancellation({...base,receipts:[],choice:'refund'}),/Aucun paiement/);
 assert.throws(()=>calculatePreInvoiceCancellation({...base,alreadyCancelled:true}),/déjà annulée/);
 assert.throws(()=>calculatePreInvoiceCancellation({...base,receipts:[receipt(1001,0)],choice:'credit'}),/supérieur/);
 assert.throws(()=>calculatePreInvoiceCancellation({...base,balance:Number.MIN_SAFE_INTEGER,choice:'credit'}),/trop élevé/);
});
