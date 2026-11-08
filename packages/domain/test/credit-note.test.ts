import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateFullCancellation} from '../src/credit-note.js';

test('avoir intégral : facture impayée retirée du solde sans remboursement',()=>{
 assert.deepEqual(calculateFullCancellation({balance:1600000,invoiceTotal:600000,invoiceNetPaid:0,alreadyCancelled:false}),{creditNoteTotal:600000,refund:0,retainedCredit:0,balanceAfter:1000000});
});
test('avoir intégral : facture payée, remboursement ou crédit distincts',()=>{
 const base={balance:1000000,invoiceTotal:600000,invoiceNetPaid:600000,alreadyCancelled:false};
 assert.deepEqual(calculateFullCancellation({...base,choice:'refund'}),{creditNoteTotal:600000,refund:600000,retainedCredit:0,balanceAfter:1000000});
 assert.deepEqual(calculateFullCancellation({...base,choice:'credit'}),{creditNoteTotal:600000,refund:0,retainedCredit:600000,balanceAfter:400000});
});
test('avoir intégral : paiement partiel et trop-perçu déjà conservé',()=>{
 const partial={balance:1400000,invoiceTotal:600000,invoiceNetPaid:200000,alreadyCancelled:false};
 assert.equal(calculateFullCancellation({...partial,choice:'refund'}).balanceAfter,1000000);
 assert.equal(calculateFullCancellation({...partial,choice:'credit'}).balanceAfter,800000);
 const excess={balance:900000,invoiceTotal:500000,invoiceNetPaid:600000,alreadyCancelled:false};
 assert.equal(calculateFullCancellation({...excess,choice:'refund'}).balanceAfter,1000000);
 assert.equal(calculateFullCancellation({...excess,choice:'credit'}).balanceAfter,400000);
});
test('avoir intégral : crédit en faveur du client, décisions et bornes',()=>{
 assert.equal(calculateFullCancellation({balance:0,invoiceTotal:600000,invoiceNetPaid:200000,alreadyCancelled:false,choice:'credit'}).balanceAfter,-600000);
 assert.throws(()=>calculateFullCancellation({balance:0,invoiceTotal:1,invoiceNetPaid:1,alreadyCancelled:false}),/Choisissez/);
 assert.throws(()=>calculateFullCancellation({balance:0,invoiceTotal:1,invoiceNetPaid:0,alreadyCancelled:false,choice:'refund'}),/Aucun paiement/);
 assert.throws(()=>calculateFullCancellation({balance:0,invoiceTotal:1,invoiceNetPaid:0,alreadyCancelled:true}),/déjà annulée/);
 assert.throws(()=>calculateFullCancellation({balance:0,invoiceTotal:-1,invoiceNetPaid:0,alreadyCancelled:false}),/invalide/);
 assert.throws(()=>calculateFullCancellation({balance:Number.MIN_SAFE_INTEGER,invoiceTotal:1,invoiceNetPaid:0,alreadyCancelled:false}),/trop élevé/);
});
