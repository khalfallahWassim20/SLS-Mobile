import {test} from 'node:test';import assert from 'node:assert/strict';
import {makeDayPaymentAttempt} from '../../../apps/mobile/day-invoice-payment-input.js';
import type {captureDayInvoiceForm} from '../../../apps/mobile/day-invoice-form.js';
type Form=Awaited<ReturnType<typeof captureDayInvoiceForm>>;
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',day='2026-01-01',operationId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',recordedAt='2026-01-01T09:00:00.000Z';
const form={fingerprint:'preuve',source:{preInvoice:{id:'c'}},view:{clientId,day,preInvoiceTotal:600000,salesTotal:250000,total:850000,paid:0,remaining:850000,declared:false}} as unknown as Form;
const draft={amount:'800,000',mode:'Espèces' as const,chequeNumber:'ancien numéro',chequeBank:'ancienne banque',chequeDue:'ancienne date'};
const build=(current:Form,values:Parameters<typeof makeDayPaymentAttempt>[3])=>makeDayPaymentAttempt(current,clientId,day,values,operationId,recordedAt);

test('écran règlement : un seul montant pour 600 + 250, aucun découpage',()=>{
 const attempt=build(form,draft);assert.equal(attempt.amount,800000);assert.equal(attempt.fingerprint,'preuve');assert.equal(attempt.mode,'Espèces');
 assert.deepEqual([attempt.chequeNumber,attempt.chequeBank,attempt.chequeDue],['','','']);
 assert.deepEqual(Object.keys(attempt).sort(),['amount','chequeBank','chequeDue','chequeNumber','clientId','day','fingerprint','mode','operationId','recordedAt'].sort());
 assert.throws(()=>build(form,{...draft,amount:'850,001'}),/reste/);assert.throws(()=>build(form,{...draft,amount:'0'}),/montant/i);
 assert.throws(()=>build(form,{...draft,amount:'1,0005'}));
});
test('crédit total uniquement si préétablie entièrement impayée',()=>{
 const credit=build(form,{...draft,mode:'Crédit'});assert.equal(credit.amount,0);assert.equal(credit.mode,'Crédit');assert.equal(credit.chequeNumber,'');
 const paid={...form,view:{...form.view,paid:1000,remaining:849000}};assert.throws(()=>build(paid,{...draft,mode:'Crédit'}),/entièrement impayée/);
 assert.throws(()=>build({...form,view:{...form.view,declared:true}},{...draft,mode:'Crédit'}),/entièrement impayée/);
 assert.throws(()=>build({...form,source:{...form.source,preInvoice:null}},{...draft,mode:'Crédit'}),/entièrement impayée/);
});
test('chèque et identité : champs requis, normalisés et jamais repris sur un virement',()=>{
 const cheque=build(form,{...draft,mode:'Chèque',chequeNumber:' 12 ',chequeBank:' Banque ',chequeDue:' 01/02/2026 '});assert.deepEqual([cheque.chequeNumber,cheque.chequeBank,cheque.chequeDue],['12','Banque','01/02/2026']);
 assert.throws(()=>build(form,{...draft,mode:'Chèque',chequeNumber:'  '}),/Renseignez/);
 const transfer=build(form,{...draft,mode:'Virement'});assert.deepEqual([transfer.chequeNumber,transfer.chequeBank,transfer.chequeDue],['','','']);
 assert.throws(()=>makeDayPaymentAttempt(form,'autre',day,draft,operationId,recordedAt),/Facture ou journée/);
 assert.throws(()=>build({...form,view:{...form.view,remaining:0}},draft),/Facture ou journée/);
});
