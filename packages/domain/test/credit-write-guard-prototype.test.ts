import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertCreditReceiptPrototype} from '../../../apps/mobile/credit-note-write-guard-prototype.js';
test('paiement v5 : ancienne dette recalculée dans la transaction et plafond initial conservé',()=>{
 const first={prePaid:200000,oldDebtPaid:300000,creditFull:false,oldDebtLimitAtStart:1000000};
 assert.equal(assertCreditReceiptPrototype(1000000,600000,[],first),1000000);
 const second={prePaid:50000,oldDebtPaid:100000,creditFull:false,oldDebtLimitAtStart:1000000};
 assert.equal(assertCreditReceiptPrototype(1100000,600000,[first],second),700000);
 assert.throws(()=>assertCreditReceiptPrototype(1100000,600000,[first],{...second,oldDebtPaid:700001}),/dette|dépass/);
 assert.throws(()=>assertCreditReceiptPrototype(1100000,600000,[first],{...second,oldDebtLimitAtStart:1000001}),/Ancienne dette modifiée/);
 assert.throws(()=>assertCreditReceiptPrototype(1100000,600000,[{...first,oldDebtLimitAtStart:undefined} as any],second),/Ancienne dette modifiée/);
 assert.throws(()=>assertCreditReceiptPrototype(1100000,600000,[first],{...second,creditFull:true}),/crédit|Crédit/);
});
