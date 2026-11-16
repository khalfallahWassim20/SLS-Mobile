import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uploadCompensatedSale,verifyCompensationReceipt} from '../../../apps/mobile/day-invoice-compensation-upload.ts';

const commercialId='11111111-1111-4111-8111-111111111111',operationId='22222222-2222-4222-8222-222222222222',clientId='33333333-3333-4333-8333-333333333333';
const identity={commercialId,serverOrigin:'https://test.invalid'};
const event={operationId,recordedAt:'2026-01-02T10:00:00.000Z',sale:{clientId,createdAt:'2026-01-01T09:00:00.000Z',total:150000}};
const compensation={choice:'refund',amount:50000,paid:800000,previousTotal:850000};
const expected={event,compensation},payload=JSON.stringify(expected);
const projection={operationId,clientId,commercialId,invoiceDay:'2026-01-01',eventDay:'2026-01-02',recordedAt:event.recordedAt,choice:'refund',compensation:50000,total:750000,paidBeforeCompensation:800000,applied:750000,remaining:0,balance:0,refund:50000,credit:0};
const receipt={event,compensation,projection};
const response=(status:number,body:unknown)=>({ok:status>=200&&status<300,status,json:async()=>body});

test('reçu de compensation : identité, vente, choix, dates et caisse vérifiés',()=>{
 verifyCompensationReceipt(expected,receipt,commercialId);
 for(const altered of [
  {...receipt,event:{...event,sale:{...event.sale,total:1}}},
  {...receipt,compensation:{...compensation,choice:'credit'}},
  {...receipt,projection:{...projection,commercialId:clientId}},
  {...receipt,projection:{...projection,eventDay:'2026-01-01'}},
  {...receipt,projection:{...projection,refund:0}},
  {...receipt,projection:{...projection,applied:800000}},
  {...receipt,projection:{...projection,balance:NaN}},
 ])assert.throws(()=>verifyCompensationReceipt(expected,altered,commercialId),/conservée/);
});

test('reprise de compensation : aucun acquittement avant preuve serveur',async()=>{
 let ack=0;const io={check:()=>{},send:async()=>response(201,{status:'received',operationId}),receipt:async()=>response(200,receipt),acknowledge:async(p:string)=>{assert.equal(p,payload);ack++;}};
 await uploadCompensatedSale(payload,identity,identity,io);assert.equal(ack,1);
 await uploadCompensatedSale(payload,identity,identity,{...io,send:async()=>response(200,{status:'duplicate',operationId})});assert.equal(ack,2);
 for(const overrides of [
  {send:async()=>{throw Error('réponse perdue');}},
  {send:async()=>response(200,{status:'duplicate',operationId:clientId})},
  {receipt:async()=>response(404,{})},
  {receipt:async()=>response(200,{...receipt,compensation:{...compensation,amount:1}})},
 ]){await assert.rejects(uploadCompensatedSale(payload,identity,identity,{...io,...overrides}));assert.equal(ack,2);}
 let checks=0;await assert.rejects(uploadCompensatedSale(payload,identity,identity,{...io,check:()=>{if(++checks===3)throw Error('session changée');}}),/session changée/);assert.equal(ack,2);
 await assert.rejects(uploadCompensatedSale(payload,identity,{...identity,serverOrigin:'https://other.invalid'},io),/différent/);assert.equal(ack,2);
});
