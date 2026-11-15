import {test} from 'node:test';import assert from 'node:assert/strict';
import {validateDayPayment,validateDayInvoiceWrite,reconcileDayInvoicePayments} from '../src/day-invoice.js';
import {projectDayInvoiceView} from '../src/day-invoice-view.js';
import {parseDayInvoicePayment} from '../../../apps/api/src/day-invoice-protocol.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',invoiceId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',saleId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',operationId='11111111-1111-4111-8111-111111111111',day='2026-01-01';
const declaration={operationId,clientId,day,recordedAt:'2026-01-01T09:00:00.000Z',amount:0,mode:'Crédit' as const,chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]};
const source={clientId,day,preInvoice:{id:invoiceId,version:1,total:600000,paid:0,declared:false},sales:[{id:saleId,version:1,total:250000,paid:0}],dayPayments:[]};
test('déclaration de crédit total : 850 DT en dette, aucun encaissement et paiement ultérieur possible',()=>{
 assert.deepEqual(parseDayInvoicePayment(declaration),declaration);
 const result=validateDayInvoiceWrite(declaration,source);assert.equal(result.total,850000);assert.equal(result.remaining,850000);assert.equal(result.dayPayments,0);assert.equal(result.declaresPreInvoice,true);
 const declared={...source,preInvoice:{...source.preInvoice,declared:true}};
 const view=projectDayInvoiceView(declared,[declaration],[]);assert.equal(view.total,850000);assert.equal(view.paid,0);assert.equal(view.remaining,850000);assert.equal(view.collectionByDay[0].total,0);
 const firstPayment={...declaration,operationId:'22222222-2222-4222-8222-222222222222',amount:200000,mode:'Espèces' as const,preInvoice:{...declaration.preInvoice,declare:false}};
 const next=validateDayInvoiceWrite(firstPayment,{...declared,dayPayments:[{id:operationId,amount:0,declaration:true}]});assert.equal(next.remaining,650000);
 const balance=reconcileDayInvoicePayments(250000,clientId,day,[declaration],[],[{id:invoiceId,total:600000,declared:false}]);assert.equal(balance.balance,850000);
});
test('crédit total refusé après paiement, avec montant positif ou sans préétablie à déclarer',()=>{
 assert.throws(()=>validateDayInvoiceWrite(declaration,{...source,sales:[{...source.sales[0],paid:1}]}),/entièrement impayée/);
 for(const invalid of [{...declaration,amount:1},{...declaration,preInvoice:null},{...declaration,preInvoice:{...declaration.preInvoice,declare:false}},{...declaration,mode:'Espèces' as const},{...declaration,chequeNumber:'X'}])assert.throws(()=>validateDayPayment(invalid));
 assert.throws(()=>validateDayInvoiceWrite(declaration,{...source,dayPayments:[{id:'33333333-3333-4333-8333-333333333333',amount:1}]}),/entièrement impayée/);
});

test('crédit total dans la preuve de caisse : déclaration présente, encaissement nul',async()=>{
 const {dayInvoiceCashClosureCanonical}=await import('../src/day-invoice-cash.js');
 const commercialId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 const sales={version:5,commercialId,day,initialEvents:[],refundEvents:[],saleStates:[]};
 const journal={version:5,commercialId,day,events:[{kind:'invoice',operationId:'55555555-5555-4555-8555-555555555555',invoiceId,clientId,recordedAt:declaration.recordedAt,amount:600000}]};
 const proof=JSON.parse(dayInvoiceCashClosureCanonical(sales,journal,[declaration],commercialId,day,[declaration]));
 assert.equal(proof.dayPayments[0].amount,0);assert.equal(proof.ownerDeclarations[0].mode,'Crédit');assert.equal(proof.dayPayments.length,1);
});
