import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateJournalClient, calculateJournalDay, validatePreInvoiceCreditChoice } from '../src/journal.js';
const pay = (amount: number) => ({ amount, mode: 'espèces' as const });
const client = { clientId: 'client-1', preInvoiceTotal: 600000, preInvoicePayments: [], oldDebtPayments: [], oldBalance: 1000000, tourInvoices: [] };

test('facture de 600 DT à crédit et paiement de 300 DT sur ancienne dette', () => {
 const r = calculateJournalClient({ ...client, oldDebtPayments: [pay(300000)] });
 assert.equal(r.totalBilled, 600000); assert.equal(r.totalCollected, 300000);
 assert.equal(r.balanceAfterPreInvoiceAndOldDebt, 1300000);
 assert.equal(r.preInvoiceBalanceDelta, 300000);
 validatePreInvoiceCreditChoice(600000, 0, true);
});
test('paiement partiel : seul le reste est ajouté à la dette', () => {
 const r = calculateJournalClient({ ...client, preInvoicePayments: [pay(200000)] });
 assert.equal(r.remainingToday, 400000); assert.equal(r.preInvoiceBalanceDelta, 400000);
 assert.equal(r.balanceAfterPreInvoiceAndOldDebt, 1400000);
 validatePreInvoiceCreditChoice(600000, 200000, false);
 assert.throws(() => validatePreInvoiceCreditChoice(600000, 200000, true));
 assert.throws(() => validatePreInvoiceCreditChoice(600000, 0, false));
});
test('900 DT encaissés : paiement facture et dette sont distincts', () => {
 const r = calculateJournalClient({ ...client, preInvoicePayments: [pay(600000)], oldDebtPayments: [pay(300000)] });
 assert.equal(r.totalCollected, 900000); assert.equal(r.totalBilled, 600000);
 assert.equal(r.balanceAfterPreInvoiceAndOldDebt, 700000);
});
test('plusieurs paiements et factures de tournée sans double comptage', () => {
 const r = calculateJournalClient({ ...client, preInvoicePayments: [pay(100000), pay(200000)], oldDebtPayments: [pay(50000)], tourInvoices: [{total:250000, paid:100000}, {total:100000, paid:100000, cancelled:true}] });
 assert.equal(r.totalBilled, 850000); assert.equal(r.totalCollected, 450000);
 assert.equal(r.remainingToday, 450000); assert.equal(r.preInvoiceBalanceDelta, 250000);
});
test('refuse surpaiements, montants invalides et clients dupliqués', () => {
 assert.throws(() => calculateJournalClient({ ...client, preInvoicePayments: [pay(600001)] }));
 assert.throws(() => calculateJournalClient({ ...client, oldDebtPayments: [pay(1000001)] }));
 assert.throws(() => calculateJournalClient({ ...client, preInvoiceTotal: 0 }));
 assert.throws(() => calculateJournalClient({ ...client, preInvoicePayments: [pay(0)] }));
 assert.throws(() => calculateJournalDay([client, client]));
});
test('totaux de journée et client sans facture préétablie', () => {
 const result = calculateJournalDay([client, { ...client, clientId:'client-2', preInvoiceTotal:null, tourInvoices:[{total:250000,paid:250000}] }]);
 assert.equal(result.clientCount,2); assert.equal(result.totalBilled,850000); assert.equal(result.totalCollected,250000);
});

test('traitement local : crédit total puis paiement ultérieur sans double ajout', async () => {
 const { summarizePreInvoice, validatePreInvoiceReceipt } = await import('../src/journal.js');
 const initial={prePaid:0,oldDebtPaid:300000,creditFull:true};
 const first=validatePreInvoiceReceipt(600000,[],initial,1000000);
 assert.deepEqual(first,{prePaid:0,oldDebtPaid:300000,remaining:600000,declared:true,debtEffect:300000,totalCollected:300000});
 const second=validatePreInvoiceReceipt(600000,[initial],{prePaid:200000,oldDebtPaid:0,creditFull:false},700000);
 assert.equal(second.debtEffect,100000); assert.equal(second.totalCollected,500000);
 assert.throws(()=>validatePreInvoiceReceipt(600000,[initial],{prePaid:600001,oldDebtPaid:0,creditFull:false},700000));
 assert.throws(()=>validatePreInvoiceReceipt(600000,[],{prePaid:0,oldDebtPaid:1000001,creditFull:true},1000000));
 assert.throws(()=>validatePreInvoiceReceipt(600000,[],{prePaid:0,oldDebtPaid:300000,creditFull:false},1000000));
});
test('saisie non traitée ne crée pas encore de dette ; un paiement partiel l’active', async () => {
 const { summarizePreInvoice, validatePreInvoiceReceipt } = await import('../src/journal.js');
 assert.equal(summarizePreInvoice(600000,[]).debtEffect,0);
 assert.equal(validatePreInvoiceReceipt(600000,[],{prePaid:200000,oldDebtPaid:0,creditFull:false},0).debtEffect,400000);
 assert.throws(()=>validatePreInvoiceReceipt(600000,[],{prePaid:200000,oldDebtPaid:0,creditFull:true},0));
});
