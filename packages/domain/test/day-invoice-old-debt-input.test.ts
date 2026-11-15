import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareOldDebtInput} from '../../../apps/mobile/day-invoice-old-debt-input.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',operationId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const form={clientId,clientName:'Client',day:'2026-01-01',available:500000,fingerprint:'preuve'};
const draft={amount:'200,125',mode:'Espèces' as const,chequeNumber:'ancien',chequeBank:'ancien',chequeDue:'ancien'};
test('préparation distincte : millimes, identité, preuve et champs de paiement',()=>{
 const result=prepareOldDebtInput(form,draft,operationId,'2026-01-01T10:00:00.000Z');
 assert.equal(result.fingerprint,'preuve');assert.equal(result.event.invoiceDay,form.day);assert.deepEqual(result.event.event.settlement,{syncOperationId:operationId,createdAt:'2026-01-01T10:00:00.000Z',clientId,clientName:'Client',amount:200125,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''});
 const cheque=prepareOldDebtInput(form,{...draft,mode:'Chèque',chequeNumber:' 123 ',chequeBank:' Banque ',chequeDue:' 01/02/2026 '},operationId,'2026-01-01T10:00:00.000Z');assert.equal(cheque.event.event.settlement.chequeNumber,'123');assert.equal(cheque.event.event.settlement.chequeBank,'Banque');
});
test('préparation distincte refuse montant excessif, chèque incomplet et changement de journée tunisienne',()=>{
 for(const amount of ['0','500,001','-1','abc'])assert.throws(()=>prepareOldDebtInput(form,{...draft,amount},operationId,'2026-01-01T10:00:00.000Z'));
 assert.throws(()=>prepareOldDebtInput(form,{...draft,mode:'Chèque',chequeBank:' '},operationId,'2026-01-01T10:00:00.000Z'),/Chèque/);
 assert.throws(()=>prepareOldDebtInput(form,draft,operationId,'2026-01-01T23:30:00.000Z'),/Date/);
 assert.throws(()=>prepareOldDebtInput(form,draft,'invalid','2026-01-01T10:00:00.000Z'),/invalide/);
});
