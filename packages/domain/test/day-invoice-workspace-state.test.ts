import {test} from 'node:test';import assert from 'node:assert/strict';
import {pendingDayWork} from '../../../apps/mobile/day-invoice-workspace-state.js';
import type {StoredPreinvoiceAttempt} from '../../../apps/mobile/day-invoice-preinvoice-attempt.js';
import type {StoredSaleAttempt} from '../../../apps/mobile/day-invoice-sale-attempt-flow.js';
import type {StoredPaymentAttempt} from '../../../apps/mobile/day-invoice-payment-attempt.js';
import type {StoredOldDebtAttempt} from '../../../apps/mobile/day-invoice-old-debt-attempt.js';
const base={preinvoice:null,sale:null,payment:null,oldDebt:null};
test('espace facture : toute tentative ou reçu impose une reprise avant une nouvelle saisie',()=>{
 assert.equal(pendingDayWork(base),null);
 const preinvoice={attempt:{clientId:'a',day:'2026-01-01'},result:{}} as StoredPreinvoiceAttempt;
 const sale={attempt:{clientId:'b',day:'2026-01-02'},result:null} as StoredSaleAttempt;
 const payment={attempt:{clientId:'c',day:'2026-01-03'},result:null} as StoredPaymentAttempt;
 const oldDebt={attempt:{event:{invoiceDay:'2026-01-04',event:{settlement:{clientId:'d'}}}},result:null} as StoredOldDebtAttempt;
 assert.deepEqual(pendingDayWork({...base,preinvoice,sale,payment,oldDebt}),{kind:'preinvoice',clientId:'a',day:'2026-01-01'});
 assert.deepEqual(pendingDayWork({...base,sale,payment,oldDebt}),{kind:'sale',clientId:'b',day:'2026-01-02'});
 assert.deepEqual(pendingDayWork({...base,payment,oldDebt}),{kind:'payment',clientId:'c',day:'2026-01-03'});
 assert.deepEqual(pendingDayWork({...base,oldDebt}),{kind:'oldDebt',clientId:'d',day:'2026-01-04'});
});
