import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {orderDayInvoiceSync} from '../../../apps/mobile/day-invoice-sync-order.js';
import type {IdentifiedEntry} from '../../../apps/mobile/identified-upload.js';
import type {DayInvoiceQueueEntry} from '../../../apps/mobile/day-invoice-queue.js';

const clientId=randomUUID(),commercialId=randomUUID(),saleId=randomUUID(),day='2026-01-01';
const at=(minute:number)=>`2026-01-01T09:${String(minute).padStart(2,'0')}:00.000Z`;
function sale(version:number,minute:number):IdentifiedEntry{
 const operationId=randomUUID();return {operationId,entityId:saleId,commercialId,recordedAt:at(minute),kind:'sale',payload:JSON.stringify({operationId,saleId,version,sale:{clientId,createdAt:at(0),syncSaleId:saleId,syncVersion:version}})};
}
function payment(version:number,sequence:number,minute:number):DayInvoiceQueueEntry{
 const operationId=randomUUID();return {sequence,operationId,commercialId,serverOrigin:'https://example.test',payload:JSON.stringify({operationId,clientId,day,recordedAt:at(minute),sales:[{id:saleId,version}],preInvoice:null})};
}
test('paiement hors ligne avant révision : la preuve de version fixe l’ordre',()=>{
 const original=sale(1,0),edit=sale(2,20),first=payment(1,1,10),second=payment(2,2,30);
 assert.deepEqual(orderDayInvoiceSync([original,edit],[first,second],[]).map(x=>x.entry.operationId),[original.operationId,first.operationId,edit.operationId,second.operationId]);
});
test('égalité de dates : priorité aux versions prouvées, conflit cyclique refusé',()=>{
 const original=sale(1,0),edit=sale(2,0),first=payment(1,1,0),second=payment(2,2,0);
 assert.deepEqual(orderDayInvoiceSync([original,edit],[first,second],[]).map(x=>x.entry.operationId),[original.operationId,first.operationId,edit.operationId,second.operationId]);
 assert.throws(()=>orderDayInvoiceSync([original,edit],[payment(2,1,10),payment(1,2,20)],[]),/ambigu/);
});
test('nouvelle vente absente du paiement : ne pas la transmettre avant ce paiement',()=>{
 const original=sale(1,0),first=payment(1,1,10),other=sale(1,20),id=randomUUID();
 other.entityId=id;const event=JSON.parse(other.payload);event.saleId=id;event.sale.syncSaleId=id;other.payload=JSON.stringify(event);
 assert.deepEqual(orderDayInvoiceSync([original,other],[first],[]).map(x=>x.entry.operationId),[original.operationId,first.operationId,other.operationId]);
});
