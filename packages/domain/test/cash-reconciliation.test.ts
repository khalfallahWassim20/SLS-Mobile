import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {compareCashReconciliation} from '../src/cash-reconciliation.js';

test('comparaison journal : identité, doublons, contenu et non seulement les totaux',()=>{
 const commercialId=randomUUID(),day='2026-11-08',id=randomUUID(),clientId=randomUUID(),invoiceId=randomUUID(),receiptId=randomUUID();
 const receipt={kind:'receipt' as const,operationId:id,clientId,invoiceId,receiptId,recordedAt:'2026-11-08T10:00:00.000Z',prePaid:250000,oldDebtPaid:400000,creditFull:false,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:''};
 const local={version:5,commercialId,day,events:[receipt]};
 assert.equal(compareCashReconciliation(local,{...local,events:[{...receipt,recordedAt:'2026-11-08T10:00:00Z'}]},commercialId,day).matches,true);
 const absent=compareCashReconciliation(local,{...local,events:[{...receipt,operationId:randomUUID()}]},commercialId,day);assert.equal(absent.onlyLocal,1);assert.equal(absent.onlyServer,1);assert.deepEqual(absent.differences.map(x=>x.status),['local','server']);
 const changed=compareCashReconciliation(local,{...local,events:[{...receipt,prePaid:300000,oldDebtPaid:350000}]},commercialId,day);assert.equal(changed.changed,1);assert.deepEqual(changed.differences,[{status:'changed',kind:'receipt',operationId:id}]);
 assert.throws(()=>compareCashReconciliation(local,{...local,commercialId:randomUUID()},commercialId,day),/identité/);
 assert.throws(()=>compareCashReconciliation(local,{...local,events:[receipt,receipt]},commercialId,day),/dupliqué/);
 assert.throws(()=>compareCashReconciliation(local,{...local,events:[{...receipt,mode:'Chèque'}]},commercialId,day),/Chèque incomplet/);
 assert.throws(()=>compareCashReconciliation(local,{...local,events:[{...receipt,prePaid:-1}]},commercialId,day),/invalide/);
 assert.throws(()=>compareCashReconciliation(local,local,commercialId,'2026-02-30'),/Date/);
});
