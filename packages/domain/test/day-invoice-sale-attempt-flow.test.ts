import {test} from 'node:test';import assert from 'node:assert/strict';
import {startSaleAttempt,resumeSaleAttempt,finishSaleAttempt,abandonSaleAttempt,type SaleAttemptIO,type StoredSaleAttempt} from '../../../apps/mobile/day-invoice-sale-attempt-flow.js';
import type {NewSaleAttempt} from '../../../apps/mobile/day-invoice-sale-create-input.js';
const attempt:NewSaleAttempt={clientId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',saleId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',operationId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',day:'2026-01-01',createdAt:'2026-01-01T09:00:00.000Z',fingerprint:'preuve',lines:[{code:'X',name:'Produit',quantity:1,unitPrice:1000,discount:0,vat:0}]};
const sale={createdAt:attempt.createdAt,clientId:attempt.clientId,clientName:'Client',syncSaleId:attempt.saleId,syncVersion:1,lines:attempt.lines,total:1000,paid:0,remaining:1000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
function fixture(){let value:StoredSaleAttempt|null=null,writes=0;let losePrepare=false,loseConfirm=false,loseAck=false;
 const io:SaleAttemptIO={read:async()=>value,prepare:async a=>{if(value)throw Error('déjà ouvert');value={attempt:a,result:null};if(losePrepare){losePrepare=false;throw Error('préparation perdue');}return value;},confirm:async id=>{if(!value||value.attempt.operationId!==id)throw Error('identifiant');if(!value.result){writes++;value={...value,result:{status:'saved',sale,operationId:id,balanceAfter:1000}};}if(loseConfirm){loseConfirm=false;throw Error('confirmation perdue');}return value.result!;},acknowledge:async id=>{if(!value||value.attempt.operationId!==id||!value.result)throw Error('accusé');value=null;if(loseAck){loseAck=false;throw Error('accusé perdu');}},cancel:async id=>{if(!value||value.attempt.operationId!==id||value.result)throw Error('abandon');value=null;}};
 return {io,get value(){return value;},get writes(){return writes;},losePrepare:()=>{losePrepare=true;},loseConfirm:()=>{loseConfirm=true;},loseAck:()=>{loseAck=true;}};
}
test('écran : préparation et confirmation perdues restent reprenables sans double vente',async()=>{
 const f=fixture();f.losePrepare();await assert.rejects(startSaleAttempt(f.io,attempt),/préparation perdue/);assert.ok(f.value);assert.equal(f.writes,0);
 f.loseConfirm();await assert.rejects(resumeSaleAttempt(f.io,attempt),/confirmation perdue/);assert.equal(f.writes,1);assert.ok(f.value?.result);
 const resumed=await resumeSaleAttempt(f.io,attempt);assert.ok(resumed.result);assert.equal(f.writes,1);
 f.loseAck();await finishSaleAttempt(f.io,attempt);assert.equal(f.value,null);assert.equal(f.writes,1);
});
test('écran : refuse autre tentative et abandon seulement avant confirmation',async()=>{
 const f=fixture(),other={...attempt,operationId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'};await f.io.prepare(attempt);
 await assert.rejects(resumeSaleAttempt(f.io,other),/différente/);await assert.rejects(finishSaleAttempt(f.io,attempt),/absent/);assert.equal(f.writes,0);
 await abandonSaleAttempt(f.io,attempt);assert.equal(f.value,null);
 await startSaleAttempt(f.io,attempt);await assert.rejects(abandonSaleAttempt(f.io,attempt),/abandonnable/);assert.equal(f.writes,1);
});
