import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dayInvoicePaymentHash,parseDayInvoicePayment} from '../../../apps/api/src/day-invoice-protocol.js';
const event={operationId:'11111111-1111-4111-8111-111111111111',clientId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',day:'2026-01-01',recordedAt:'2026-01-01T12:00:00.000Z',amount:150000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',version:1,total:600000,declare:true},sales:[{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',version:1}]};
test('protocole serveur : représentation canonique stable et données immuables',()=>{
 assert.deepEqual(parseDayInvoicePayment(event),event);
 const shuffled=Object.fromEntries(Object.entries(event).reverse());
 assert.equal(dayInvoicePaymentHash(event),dayInvoicePaymentHash(shuffled));
 assert.notEqual(dayInvoicePaymentHash(event),dayInvoicePaymentHash({...event,amount:150001}));
 assert.notEqual(dayInvoicePaymentHash(event),dayInvoicePaymentHash({...event,preInvoice:{...event.preInvoice,version:2}}));
});
test('protocole serveur : rejette champs étrangers, dates invalides, preuve incohérente et chèque incomplet',()=>{
 assert.throws(()=>parseDayInvoicePayment({...event,extra:1}));
 assert.throws(()=>parseDayInvoicePayment({...event,day:'2026-02-30'}));
 assert.throws(()=>parseDayInvoicePayment({...event,recordedAt:'2026-01-01'}));
 assert.throws(()=>parseDayInvoicePayment({...event,preInvoice:{...event.preInvoice,total:0}}));
 assert.throws(()=>parseDayInvoicePayment({...event,sales:[event.sales[0],event.sales[0]]}));
 assert.throws(()=>parseDayInvoicePayment({...event,mode:'Chèque'}));
});
