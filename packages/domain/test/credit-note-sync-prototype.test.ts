import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {syncCreditPrototype} from '../../../apps/mobile/credit-note-sync-prototype.js';
import type {IdentifiedEntry} from '../../../apps/mobile/identified-upload.js';
import type {Note} from '../../../apps/mobile/credit-note-offline-prototype.js';

function fixture(){
 const identity:{commercialId:string;serverOrigin:string}={commercialId:randomUUID(),serverOrigin:'https://example.test'},saleId=randomUUID(),operationId=randomUUID();
 const entry:IdentifiedEntry={commercialId:identity.commercialId,entityId:saleId,operationId,kind:'sale',recordedAt:'2026-11-08T09:00:00.000Z',payload:JSON.stringify({operationId,saleId,version:1,sale:{syncSaleId:saleId,syncVersion:1}})};
 const note:Note={kind:'sale',commercialId:identity.commercialId,serverOrigin:identity.serverOrigin,command:{operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:'2026-11-08T10:00:00.000Z',choice:null},source:{},balanceDelta:0,refund:0,retainedCredit:0};
 const events:string[]=[];let operationPending=true,creditPending=true,serverCredit=false,loseResponse=false,failFinal=false,reads=0;
 const response=(status:number,body:unknown)=>({status,ok:status>=200&&status<300,json:async()=>body});
 const io={
  readOperations:async()=>operationPending?[entry]:[],
  acknowledgeOperation:async(e:IdentifiedEntry)=>{assert.equal(e.operationId,entry.operationId);operationPending=false;events.push('ack-operation');},
  readReadyCredits:async()=>creditPending&&!operationPending?[note]:[],
  readAllCredits:async()=>[{note,pending:creditPending}],
  acknowledgeCredit:async(n:Note,reply:unknown)=>{assert.equal(n.command.operationId,note.command.operationId);assert.equal((reply as any).operationId,note.command.operationId);creditPending=false;events.push('ack-credit');},
  sendOperation:async(path:string,body:string)=>{events.push('send-'+path);return response(201,{status:'received',operationId:JSON.parse(body).operationId});},
  sendCredit:async(path:string,body:string)=>{events.push('credit-'+path);const status=serverCredit?'duplicate':'received';serverCredit=true;if(loseResponse){loseResponse=false;throw Error('réponse perdue');}return response(status==='received'?201:200,{status,operationId:JSON.parse(body).operationId});},
  fetchReference:async()=>{events.push('reference');reads++;if(failFinal&&reads===2)throw Error('référence indisponible');return {serverCredit};},
  saveReference:async(a:typeof identity,b:typeof identity,value:unknown)=>{assert.deepEqual(a,b);events.push('cache-'+(value as any).serverCredit);}
 };
 return {identity,note,entry,events,io,lose:()=>{loseResponse=true;},failFinal:()=>{failFinal=true;},isPending:()=>creditPending};
}
test('synchronisation préparatoire : dépendances, réponse perdue, reprise et référence finale',async()=>{
 const f=fixture();f.lose();
 await assert.rejects(syncCreditPrototype(f.identity,f.identity,f.io),/réponse perdue/);
 assert.equal(f.isPending(),true);
 assert.deepEqual(f.events,['reference','cache-false','send-sales','ack-operation','credit-sales']);
 const result=await syncCreditPrototype(f.identity,f.identity,f.io);
 assert.deepEqual(result,{operations:0,credits:1});assert.equal(f.isPending(),false);
 assert.deepEqual(f.events.slice(5),['reference','cache-true','credit-sales','ack-credit','reference','cache-true']);
});
test('synchronisation préparatoire : identité, référence finale et dépendance non prête',async()=>{
 const f=fixture();await assert.rejects(syncCreditPrototype(f.identity,{...f.identity,serverOrigin:'https://other.test'},f.io),/Session/);assert.deepEqual(f.events,[]);
 f.failFinal();await assert.rejects(syncCreditPrototype(f.identity,f.identity,f.io),/référence indisponible/);
 assert.equal(f.isPending(),false);assert.deepEqual(await syncCreditPrototype(f.identity,f.identity,f.io),{operations:0,credits:0});
 const g=fixture();g.io.readReadyCredits=async()=>[];
 await assert.rejects(syncCreditPrototype(g.identity,g.identity,g.io),/avoir reste en attente/);assert.equal(g.isPending(),true);
});
