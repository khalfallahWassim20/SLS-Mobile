import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {prepareCreditSaleEdit} from '../../../apps/mobile/credit-sale-edit-prototype.js';
import {saleSchema} from '../../../apps/api/src/identified-operations.js';
const identity={commercialId:randomUUID(),serverOrigin:'https://sls.example.test'},id=randomUUID();
const client={id,name:'Client fictif',sector:'Tunis',active:true,limit:1,serverBalance:1000000,balance:1000000,conflict:false,saleBlocked:true,blockReason:'limite',canSettle:true} as const,context={identity,expectedBalance:1000000};
const sale={id:1,createdAt:'2026-11-10T10:00:00.000Z',clientId:id,clientName:client.name,syncSaleId:randomUUID(),syncVersion:1,lines:[{name:'Huile',code:'H1',quantity:2,unitPrice:100000,discount:0,vat:1900}],total:238000,paid:200000,remaining:38000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
test('révision v5 : remboursement ou crédit choisi, solde recalculé même si limite atteinte',()=>{
 const lines=[{...sale.lines[0],quantity:1}];
 assert.throws(()=>prepareCreditSaleEdit(client,context,sale,lines),/Choisissez/);
 const refund=prepareCreditSaleEdit(client,context,sale,lines,'refund');assert.equal(refund.updated.total,119000);assert.equal(refund.updated.paid,119000);assert.equal(refund.refund,81000);assert.equal(refund.balanceAfter,962000);
 const credit=prepareCreditSaleEdit(client,context,sale,lines,'credit');assert.equal(credit.updated.paid,200000);assert.equal(credit.credit,81000);assert.equal(credit.balanceAfter,881000);
 const {id:_,...payload}=credit.updated;assert.equal(saleSchema.safeParse({...payload,syncVersion:2}).success,true);
});
test('révision v5 : incohérence et altération de prix refusées',()=>{
 assert.throws(()=>prepareCreditSaleEdit(client,{...context,expectedBalance:1},sale,sale.lines),/Solde/);
 assert.throws(()=>prepareCreditSaleEdit(client,context,{...sale,clientId:randomUUID()},sale.lines),/client/);
 assert.throws(()=>prepareCreditSaleEdit(client,context,sale,[]),/article/);
 assert.throws(()=>prepareCreditSaleEdit(client,context,sale,[{...sale.lines[0],unitPrice:1}]),/prix/);
 assert.throws(()=>prepareCreditSaleEdit(client,context,sale,[{...sale.lines[0],quantity:0}]),/quantité/);
 assert.throws(()=>prepareCreditSaleEdit(client,context,sale,[sale.lines[0],sale.lines[0]]),/Article/);
});
test('la validation avant écriture refuse remboursement et métadonnées altérés',async()=>{
 const {validateCreditSaleEdit}=await import('../../../apps/mobile/credit-sale-edit-prototype.js');
 const value=prepareCreditSaleEdit(client,context,sale,[{...sale.lines[0],quantity:1}],'refund');
 assert.doesNotThrow(()=>validateCreditSaleEdit(sale,value.updated,value.refund));
 assert.throws(()=>validateCreditSaleEdit(sale,value.updated,0),/incohérente/);
 assert.throws(()=>validateCreditSaleEdit(sale,{...value.updated,createdAt:'2026-01-01T00:00:00.000Z'},value.refund),/incohérente/);
 assert.throws(()=>validateCreditSaleEdit(sale,{...value.updated,total:1},value.refund),/incohérente/);
});
