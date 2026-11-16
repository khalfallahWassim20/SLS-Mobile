import {test} from 'node:test';import assert from 'node:assert/strict';
import {startSaleEditAttempt,resumeSaleEditAttempt,finishSaleEditAttempt,abandonSaleEditAttempt,type SaleEditAttemptIO} from '../../../apps/mobile/day-invoice-sale-edit-attempt-flow.js';
import type {SaleEditAttempt,StoredSaleEditAttempt} from '../../../apps/mobile/day-invoice-sale-edit-attempt.js';
const attempt={saleId:1,clientId:'client',day:'2026-01-01',lines:[],fingerprint:'fp',operationId:'op',recordedAt:'2026-01-01T10:00:00.000Z'} as SaleEditAttempt;
const receipt={updated:{total:300},assessment:{total:900}} as StoredSaleEditAttempt['result'];
function fixture(){let value:StoredSaleEditAttempt|null=null,confirms=0;const io:SaleEditAttemptIO={read:async()=>value,prepare:async a=>(value={attempt:a,result:null}),confirm:async()=>{confirms++;value={attempt,result:receipt};return receipt!;},acknowledge:async()=>{value=null;},cancel:async()=>{value=null;}};return {io,get:()=>value,set:(v:StoredSaleEditAttempt|null)=>{value=v;},count:()=>confirms};}
test('révision UI : reprise du même identifiant et confirmation unique',async()=>{
 const f=fixture();const result=await startSaleEditAttempt(f.io,attempt);assert.equal(result.result,receipt);assert.equal(f.count(),1);
 await resumeSaleEditAttempt(f.io,attempt);assert.equal(f.count(),1);await finishSaleEditAttempt(f.io,attempt);assert.equal(f.get(),null);
});
test('révision UI : erreur après écriture, reprise et accusé perdu',async()=>{
 const f=fixture();const confirm=f.io.confirm;f.io.confirm=async id=>{await confirm(id);throw Error('réponse perdue');};
 await assert.rejects(startSaleEditAttempt(f.io,attempt),/réponse perdue/);assert.ok(f.get()?.result);
 await resumeSaleEditAttempt(f.io,attempt);assert.equal(f.count(),1);
 f.io.acknowledge=async()=>{f.set(null);throw Error('réponse perdue');};await finishSaleEditAttempt(f.io,attempt);assert.equal(f.get(),null);
});
test('révision UI : refuse une autre tentative, un reçu absent et un abandon après confirmation',async()=>{
 const f=fixture();f.set({attempt:{...attempt,operationId:'autre'},result:null});await assert.rejects(resumeSaleEditAttempt(f.io,attempt),/différente/);
 f.set({attempt,result:null});await assert.rejects(finishSaleEditAttempt(f.io,attempt),/absent/);await abandonSaleEditAttempt(f.io,attempt);assert.equal(f.get(),null);
 f.set({attempt,result:receipt});await assert.rejects(abandonSaleEditAttempt(f.io,attempt),/non abandonnable/);
 f.io.read=async()=>{throw Error('lecture impossible');};await assert.rejects(finishSaleEditAttempt(f.io,attempt),/lecture impossible/);
});
