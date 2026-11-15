import {test} from 'node:test';import assert from 'node:assert/strict';
import {startPaymentAttempt,resumePaymentAttempt,finishPaymentAttempt,abandonPaymentAttempt,type PaymentAttemptIO} from '../../../apps/mobile/day-invoice-payment-attempt-flow.js';
import type {PaymentAttempt,StoredPaymentAttempt} from '../../../apps/mobile/day-invoice-payment-attempt.js';
const attempt:PaymentAttempt={clientId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',operationId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',day:'2026-01-01',recordedAt:'2026-01-01T09:00:00.000Z',fingerprint:'preuve',amount:200000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
const {fingerprint:_fingerprint,...fields}=attempt;
const payment={...fields,preInvoice:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',version:1,total:600000,declare:true},sales:[]};
function fixture(){let value:StoredPaymentAttempt|null=null,writes=0,losePrepare=false,loseConfirm=false,loseAck=false;
 const io:PaymentAttemptIO={read:async()=>value,prepare:async a=>{if(value)throw Error('déjà ouvert');value={attempt:a,result:null};if(losePrepare){losePrepare=false;throw Error('préparation perdue');}return value;},confirm:async id=>{if(!value||value.attempt.operationId!==id)throw Error('identifiant');if(!value.result){writes++;value={...value,result:{status:'created',payment}};}if(loseConfirm){loseConfirm=false;throw Error('confirmation perdue');}return value.result!;},acknowledge:async id=>{if(!value||value.attempt.operationId!==id||!value.result)throw Error('accusé');value=null;if(loseAck){loseAck=false;throw Error('accusé perdu');}},cancel:async id=>{if(!value||value.attempt.operationId!==id||value.result)throw Error('abandon');value=null;}};
 return {io,get value(){return value;},get writes(){return writes;},losePrepare:()=>{losePrepare=true;},loseConfirm:()=>{loseConfirm=true;},loseAck:()=>{loseAck=true;}};
}
test('règlement écran : réponses perdues, reprise de la même opération et accusé',async()=>{
 const f=fixture();f.losePrepare();await assert.rejects(startPaymentAttempt(f.io,attempt),/préparation perdue/);assert.ok(f.value);assert.equal(f.writes,0);
 f.loseConfirm();await assert.rejects(resumePaymentAttempt(f.io,attempt),/confirmation perdue/);assert.equal(f.writes,1);assert.ok(f.value?.result);
 assert.ok((await resumePaymentAttempt(f.io,attempt)).result);assert.equal(f.writes,1);f.loseAck();await finishPaymentAttempt(f.io,attempt);assert.equal(f.value,null);
});
test('règlement écran : autre tentative refusée et abandon réservé au brouillon',async()=>{
 const f=fixture(),other={...attempt,operationId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'};await f.io.prepare(attempt);await assert.rejects(resumePaymentAttempt(f.io,other),/différente/);
 await assert.rejects(finishPaymentAttempt(f.io,attempt),/absent/);await abandonPaymentAttempt(f.io,attempt);assert.equal(f.value,null);
 await startPaymentAttempt(f.io,attempt);await assert.rejects(abandonPaymentAttempt(f.io,attempt),/abandonnable/);assert.equal(f.writes,1);
});
