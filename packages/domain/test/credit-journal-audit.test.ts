import {test} from 'node:test';
import assert from 'node:assert/strict';
import {auditCreditJournal,type CreditJournalView} from '../src/credit-note-audit.ts';
const healthy=():CreditJournalView=>({totalBilled:900000,billedAfterCredits:600000,totalCollected:700000,journalCollected:650000,inheritedJournalTotal:30000,globalSettlementTotal:20000,saleRefundTotal:10000,collectedAfterRefunds:640000,
 creditNoteTotal:300000,creditRefundTotal:50000,creditRetainedTotal:100000,creditRefundUnassignedTotal:0,
 creditEvents:[{invoiceTotal:300000,refund:50000,retainedCredit:100000}],creditCashEvents:[{invoiceTotal:300000,refund:50000,retainedCredit:100000}],unassignedCreditRefundEvents:[],
 rows:[{clientId:'c1',preInvoicePaid:200000,oldDebtPaid:50000,tourPaid:100000,totalCollected:350000},{clientId:'c2',preInvoicePaid:0,oldDebtPaid:0,tourPaid:300000,totalCollected:300000}]});
test('journal avec avoirs : totaux cohérents',()=>{assert.deepEqual(auditCreditJournal(healthy()),[]);});
test('journal avec avoirs : un avoir d’une facture d’un autre jour peut rendre les totaux négatifs',()=>{
 const j={...healthy(),totalBilled:100000,billedAfterCredits:-200000,totalCollected:20000,journalCollected:0,inheritedJournalTotal:0,globalSettlementTotal:20000,saleRefundTotal:0,collectedAfterRefunds:-30000,rows:[]};
 assert.deepEqual(auditCreditJournal(j),[]);
});
test('journal avec avoirs : chaque écart de total est signalé',()=>{
 const codes=(patch:Partial<CreditJournalView>)=>auditCreditJournal({...healthy(),...patch}).map(i=>i.code);
 assert.ok(codes({billedAfterCredits:700000}).includes('BILLED_AFTER_MISMATCH'));
 assert.ok(codes({collectedAfterRefunds:700000}).includes('COLLECTED_AFTER_MISMATCH'));
 assert.ok(codes({creditRefundTotal:60000}).includes('REFUND_TOTAL_MISMATCH'));
 assert.ok(codes({creditRetainedTotal:0}).includes('RETAINED_TOTAL_MISMATCH'));
 assert.ok(codes({creditNoteTotal:1}).includes('CREDIT_TOTAL_MISMATCH'));
 assert.ok(codes({totalCollected:1}).includes('TOTAL_COLLECTED_MISMATCH'));
 assert.ok(codes({journalCollected:1}).includes('JOURNAL_COLLECTED_MISMATCH'));
 assert.ok(codes({creditRefundUnassignedTotal:5}).includes('UNASSIGNED_REFUND_MISMATCH'));
 assert.ok(codes({rows:[{clientId:'c1',preInvoicePaid:1,oldDebtPaid:0,tourPaid:0,totalCollected:2},...healthy().rows.slice(1)]}).includes('ROW_COLLECTED_MISMATCH'));
 assert.ok(codes({totalBilled:-1}).includes('JOURNAL_UNREADABLE'));
});
