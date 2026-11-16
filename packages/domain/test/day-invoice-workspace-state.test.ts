import {test} from 'node:test';import assert from 'node:assert/strict';
import {pendingDayWork} from '../../../apps/mobile/day-invoice-workspace-state.js';
import type {StoredPreinvoiceAttempt} from '../../../apps/mobile/day-invoice-preinvoice-attempt.js';
import type {StoredSaleEditAttempt} from '../../../apps/mobile/day-invoice-sale-edit-attempt.js';
import type {StoredSaleAttempt} from '../../../apps/mobile/day-invoice-sale-attempt-flow.js';
import type {StoredPaymentAttempt} from '../../../apps/mobile/day-invoice-payment-attempt.js';
import type {StoredOldDebtAttempt} from '../../../apps/mobile/day-invoice-old-debt-attempt.js';
const base={preinvoice:null,sale:null,saleEdit:null,payment:null,oldDebt:null};
test('espace facture : toute tentative ou reçu impose une reprise avant une nouvelle saisie',()=>{
 assert.equal(pendingDayWork(base),null);
 const preinvoice={attempt:{clientId:'a',day:'2026-01-01'},result:{}} as StoredPreinvoiceAttempt;
 const sale={attempt:{clientId:'b',day:'2026-01-02'},result:null} as StoredSaleAttempt;
 const saleEdit={attempt:{clientId:'e',day:'2026-01-05',saleId:9},result:null} as StoredSaleEditAttempt;
 const payment={attempt:{clientId:'c',day:'2026-01-03'},result:null} as StoredPaymentAttempt;
 const oldDebt={attempt:{event:{invoiceDay:'2026-01-04',event:{settlement:{clientId:'d'}}}},result:null} as StoredOldDebtAttempt;
 assert.deepEqual(pendingDayWork({...base,preinvoice,sale,payment,oldDebt}),{kind:'preinvoice',clientId:'a',day:'2026-01-01'});
 assert.deepEqual(pendingDayWork({...base,sale,payment,oldDebt}),{kind:'sale',clientId:'b',day:'2026-01-02'});
 assert.deepEqual(pendingDayWork({...base,payment,oldDebt}),{kind:'payment',clientId:'c',day:'2026-01-03'});
 assert.deepEqual(pendingDayWork({...base,saleEdit,payment}),{kind:'saleEdit',clientId:'e',day:'2026-01-05',saleId:9});
 assert.deepEqual(pendingDayWork({...base,oldDebt}),{kind:'oldDebt',clientId:'d',day:'2026-01-04'});
});

test('capture espace : ne lit les clients que si tous les registres sont vides',async()=>{
 const {captureWorkspaceState}=await import('../../../apps/mobile/day-invoice-workspace-state.js');
 const calls:string[]=[];
 const read={preinvoice:async()=>{calls.push('preinvoice');return null;},sale:async()=>{calls.push('sale');return null;},saleEdit:async()=>{calls.push('saleEdit');return null;},payment:async()=>{calls.push('payment');return null;},oldDebt:async()=>{calls.push('oldDebt');return null;},clients:async()=>{calls.push('clients');return ['client'];}};
 assert.deepEqual(await captureWorkspaceState(read),{pending:null,clients:['client']});
 assert.deepEqual(calls,['preinvoice','sale','saleEdit','payment','oldDebt','clients']);
 calls.length=0;
 const sale={attempt:{clientId:'b',day:'2026-01-02'},result:null} as StoredSaleAttempt;
 assert.deepEqual(await captureWorkspaceState({...read,sale:async()=>sale}),{pending:{kind:'sale',clientId:'b',day:'2026-01-02'},clients:null});
 assert.ok(!calls.includes('clients'));
 calls.length=0;
 await assert.rejects(captureWorkspaceState({...read,payment:async()=>{throw Error('SQLite indisponible');}}),/SQLite indisponible/);
 assert.ok(!calls.includes('clients'));
});
