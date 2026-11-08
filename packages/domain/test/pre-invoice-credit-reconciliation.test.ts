import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {reconcilePreInvoiceCredits,type CreditJournalState} from '../src/pre-invoice-credit-reconciliation.js';
const actor={id:randomUUID(),role:'commercial' as const};
const invoice=randomUUID(),r1={id:randomUUID(),prePaid:200000,oldDebtPaid:300000,creditFull:false},r2={id:randomUUID(),prePaid:50000,oldDebtPaid:100000,creditFull:false};
const base:CreditJournalState={id:invoice,version:2,total:600000,receipts:[r1],creditNote:null};
const withNote=(choice:'refund'|'credit'):CreditJournalState=>({id:invoice,version:3,total:600000,receipts:[r1,r2],creditNote:{operationId:randomUUID(),expectedVersion:3,choice,recordedAt:'2026-11-08T12:00:00.000Z',actor}});
test('préétablie hors ligne : paiements en attente puis avoir, sans toucher à l’ancienne dette',()=>{
 const refund=withNote('refund'),credit=withNote('credit');
 // Serveur : dette initiale 1000 + reste 400 - ancienne dette réglée 300 = 1100.
 assert.deepEqual(reconcilePreInvoiceCredits(1100000,[refund],[base]),{balance:600000,conflict:false});
 assert.deepEqual(reconcilePreInvoiceCredits(1100000,[credit],[base]),{balance:350000,conflict:false});
 // Une fois l'avoir reçu, ne pas compter son effet deux fois.
 assert.deepEqual(reconcilePreInvoiceCredits(600000,[refund],[refund]),{balance:600000,conflict:false});
 assert.deepEqual(reconcilePreInvoiceCredits(350000,[credit],[credit]),{balance:350000,conflict:false});
});
test('nouvelle préétablie annulée localement, déclarée ou non',()=>{
 const draft:CreditJournalState={id:randomUUID(),version:1,total:600000,receipts:[],creditNote:{operationId:randomUUID(),expectedVersion:1,choice:null,recordedAt:'2026-11-08T12:00:00.000Z',actor}};
 assert.deepEqual(reconcilePreInvoiceCredits(1000000,[draft],[]),{balance:1000000,conflict:false});
 const paid=withNote('refund');assert.deepEqual(reconcilePreInvoiceCredits(1000000,[paid],[]),{balance:600000,conflict:false});
 const credit=withNote('credit');assert.deepEqual(reconcilePreInvoiceCredits(1000000,[credit],[]),{balance:350000,conflict:false});
});
test('reprise différente, facture modifiée à distance et règlement divergent signalés',()=>{
 const note=withNote('credit');
 assert.equal(reconcilePreInvoiceCredits(350000,[{...note,creditNote:{...note.creditNote!,operationId:randomUUID()}}],[note]).conflict,true);
 assert.equal(reconcilePreInvoiceCredits(350000,[{...note,creditNote:null}],[note]).conflict,true);
 assert.equal(reconcilePreInvoiceCredits(1100000,[{...base,receipts:[{...r1,prePaid:199999}]}],[base]).conflict,true);
 assert.equal(reconcilePreInvoiceCredits(1100000,[{...base,version:1}],[base]).conflict,true);
 const local2={...base,id:randomUUID()};assert.equal(reconcilePreInvoiceCredits(1100000,[local2],[base]).conflict,true);
 assert.equal(reconcilePreInvoiceCredits(350000,[{...note,id:randomUUID(),receipts:[{...r1,id:randomUUID()},{...r2,id:randomUUID()}]}],[note]).conflict,true);
});
test('refuse les valeurs et doublons invalides et les dépassements',()=>{
 const note=withNote('refund');
 assert.throws(()=>reconcilePreInvoiceCredits(0,[note,note],[]),/dupliqué/);
 assert.throws(()=>reconcilePreInvoiceCredits(0,[{...note,creditNote:{...note.creditNote!,expectedVersion:2}}],[]),/invalide/);
 assert.throws(()=>reconcilePreInvoiceCredits(Number.MIN_SAFE_INTEGER,[note],[]),/trop élevé/);
});
