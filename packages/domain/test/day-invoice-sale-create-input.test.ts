import {test} from 'node:test';import assert from 'node:assert/strict';
import {makeNewSaleAttempt} from '../../../apps/mobile/day-invoice-sale-create-input.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',saleId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',operationId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const line={code:'X',name:'Produit',quantity:1,unitPrice:210084,discount:0,vat:1900};
const preview={clientId,clientName:'Client',day:'2026-01-01',lines:[line],total:250000,balanceBefore:0,balanceAfter:250000,invoiceTotal:850000,fingerprint:'preuve'};
test('tentative stable : identités distinctes, copie et heure tunisienne',()=>{
 const ids=[saleId,operationId],attempt=makeNewSaleAttempt(preview,new Date('2026-01-01T22:59:59.000Z'),()=>ids.shift()!);
 assert.deepEqual(attempt,{clientId,day:preview.day,lines:[line],fingerprint:'preuve',saleId,operationId,createdAt:'2026-01-01T22:59:59.000Z'});
 attempt.lines[0].quantity=5;assert.equal(line.quantity,1);
 assert.throws(()=>makeNewSaleAttempt(preview,new Date('2026-01-01T23:00:00.000Z'),()=>saleId),/journée/i);
 assert.throws(()=>makeNewSaleAttempt(preview,new Date('invalid'),()=>saleId),/aperçu/i);
 assert.throws(()=>makeNewSaleAttempt(preview,new Date('2026-01-01T10:00:00.000Z'),()=>saleId),/Identifiants/);
 assert.throws(()=>makeNewSaleAttempt({...preview,fingerprint:''},new Date('2026-01-01T10:00:00.000Z'),()=>saleId),/aperçu/i);
});
