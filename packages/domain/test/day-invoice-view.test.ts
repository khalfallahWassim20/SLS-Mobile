import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectDayInvoiceView} from '../src/day-invoice-view.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',invoiceId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',saleId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const source={clientId,day:'2026-01-01',preInvoice:{id:invoiceId,version:1,total:600000,paid:50000,declared:true},sales:[{id:saleId,version:1,total:250000,paid:25000}]};
const p={operationId:'11111111-1111-4111-8111-111111111111',clientId,day:source.day,recordedAt:'2026-01-01T20:00:00.000Z',amount:200000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:false},sales:[{id:saleId,version:1}]};
const q={...p,operationId:'22222222-2222-4222-8222-222222222222',recordedAt:'2026-01-01T23:30:00.000Z',amount:100000,mode:'Chèque' as const,chequeNumber:'1',chequeBank:'Banque',chequeDue:'2026-02-01'};
test('vue client/jour : une facture égale à la somme, sans double paiement lors de la réponse perdue',()=>{
 const view=projectDayInvoiceView(source,[p,q],[p]);
 assert.deepEqual([view.preInvoiceTotal,view.salesTotal,view.total,view.paid,view.remaining],[600000,250000,850000,375000,475000]);
 assert.deepEqual(view.payments.map(x=>x.pending),[false,true]);
 assert.deepEqual(view.collectionByDay,[{day:'2026-01-01',total:200000,cash:200000,cheque:0,transfer:0},{day:'2026-01-02',total:100000,cash:0,cheque:100000,transfer:0}]);
});
test('vue : refuse copies divergentes, preuves manquantes, dépassement et doublons',()=>{
 assert.throws(()=>projectDayInvoiceView(source,[p],[{...p,amount:199999}]),/divergent/);
 assert.throws(()=>projectDayInvoiceView(source,[p,p],[]),/dupliqué/);
 assert.throws(()=>projectDayInvoiceView(source,[{...p,clientId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}],[]),/étranger/);
 assert.throws(()=>projectDayInvoiceView({...source,sales:[]},[p],[]),/vente/);
 assert.throws(()=>projectDayInvoiceView(source,[{...p,amount:775001}],[]),/supérieur/);
 assert.throws(()=>projectDayInvoiceView(source,[{...p,preInvoice:{...p.preInvoice,total:1}}],[]),/facture/);
});
test('vue : dette ancienne n’est pas assimilée à un paiement de la facture',()=>{
 const view=projectDayInvoiceView({...source,preInvoice:{...source.preInvoice,paid:0},sales:[{...source.sales[0],paid:0}]},[],[]);
 assert.equal(view.total,850000);assert.equal(view.paid,0);assert.equal(view.remaining,850000);assert.deepEqual(view.collectionByDay,[]);
});

test('préétablie ajoutée après règlement d’une vente : ne rejette ni ne répartit le paiement initial',()=>{
 const old={...p,preInvoice:null,sales:[{id:saleId,version:1}],amount:100000};
 const source={clientId,day:'2026-01-01',preInvoice:{id:invoiceId,version:1,total:600000,paid:0,declared:false},sales:[{id:saleId,version:1,total:250000,paid:0}]};
 const result=projectDayInvoiceView(source,[],[old]);assert.equal(result.total,850000);assert.equal(result.paid,100000);assert.equal(result.remaining,750000);assert.equal(result.declared,false);
});
