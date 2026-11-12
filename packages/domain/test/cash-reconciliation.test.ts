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

test('preuve de clôture : ordre stable et changements détectés même à totaux égaux',async()=>{
 const {cashClosureCanonical}=await import('../src/cash-reconciliation.js');
 const commercialId=randomUUID(),day='2026-11-08',clientId=randomUUID(),invoiceId=randomUUID();
 const invoice={kind:'invoice' as const,operationId:randomUUID(),clientId,recordedAt:'2026-11-08T08:00:00.000Z',invoiceId,amount:600000};
 const receipt={kind:'receipt' as const,operationId:randomUUID(),clientId,recordedAt:'2026-11-08T09:00:00.000Z',invoiceId,receiptId:randomUUID(),prePaid:250000,oldDebtPaid:400000,creditFull:false,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:''};
 const sales={version:5,commercialId,day,initialEvents:[],refundEvents:[],saleStates:[]};
 const journal={version:5,commercialId,day,events:[invoice,receipt]};
 const canonical=cashClosureCanonical(sales,journal,commercialId,day);
 assert.equal(canonical,cashClosureCanonical(sales,{...journal,events:[{...receipt,recordedAt:'2026-11-08T09:00:00Z'},invoice]},commercialId,day));
 assert.notEqual(canonical,cashClosureCanonical(sales,{...journal,events:[invoice,{...receipt,prePaid:300000,oldDebtPaid:350000}]},commercialId,day));
 assert.throws(()=>cashClosureCanonical(sales,{...journal,events:[invoice,invoice]},commercialId,day),/dupliqué/);
 assert.throws(()=>cashClosureCanonical(sales,{...journal,events:[{...invoice,recordedAt:'2026-11-07T10:00:00.000Z'}]},commercialId,day),/journée|date/i);
 // La journée suit Tunis (UTC+1), pas la date UTC.
 assert.doesNotThrow(()=>cashClosureCanonical(sales,{...journal,events:[{...invoice,recordedAt:'2026-11-07T23:00:00.000Z'}]},commercialId,day));
 assert.throws(()=>cashClosureCanonical(sales,{...journal,events:[{...invoice,recordedAt:'2026-11-08T23:00:00.000Z'}]},commercialId,day),/journée/);
});

test('preuve : avoir propriétaire et remboursement coexistent avec le même UUID sans doublement',async()=>{
 const {cashClosureCanonical}=await import('../src/cash-reconciliation.js');
 const commercialId=randomUUID(),day='2026-11-08',operationId=randomUUID(),invoiceId=randomUUID(),clientId=randomUUID(),recordedAt='2026-11-08T10:00:00.000Z';
 const owned={kind:'owner-credit' as const,operationId,invoiceId,clientId,recordedAt,invoiceKind:'preinvoice' as const,invoiceTotal:600000,refund:250000,retainedCredit:0};
 const admin={kind:'admin-refund' as const,operationId,invoiceId,clientId,recordedAt,invoiceKind:'preinvoice' as const,assignmentId:randomUUID(),refund:250000};
 const local={version:5,commercialId,day,events:[owned,admin]},sales={version:5,commercialId,day,initialEvents:[],refundEvents:[],saleStates:[]};
 assert.equal(compareCashReconciliation(local,{...local,events:[admin,owned]},commercialId,day).matches,true);
 assert.equal(cashClosureCanonical(sales,local,commercialId,day),cashClosureCanonical(sales,{...local,events:[admin,owned]},commercialId,day));
 assert.equal(compareCashReconciliation(local,{...local,events:[admin]},commercialId,day).onlyLocal,1);
 assert.equal(compareCashReconciliation(local,{...local,events:[admin,{...owned,invoiceTotal:1}]},commercialId,day).changed,1);
 assert.throws(()=>cashClosureCanonical(sales,{...local,events:[owned,owned]},commercialId,day),/dupliqué/);
});
