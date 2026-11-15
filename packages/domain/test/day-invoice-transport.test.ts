import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDayInvoiceTransportPrototype} from '../../../apps/mobile/day-invoice-transport.js';
const identity={commercialId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',serverOrigin:'http://192.168.1.10:3001'},lineageId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',pin={...identity,lineageId},now=Date.parse('2026-01-01T12:00:00.000Z');
const session={id:identity.commercialId,name:'Commercial fictif',serverOrigin:identity.serverOrigin,token:'jeton fictif',expiresAt:'2026-01-02T12:00:00.000Z'};
test('transport v6 : aucune écriture sans identité et lignée vérifiées',async()=>{
 const calls:string[]=[];let current=true;
 const io={now:()=>now,isCurrentSession:()=>current,allowPrivateHttp:true,request:async(url:string)=>{calls.push(url);return {ok:true,status:200,json:async()=>url.endsWith('/server-lineage')?{version:1,commercialId:identity.commercialId,lineageId}:{version:6}};}};
 const transport=createDayInvoiceTransportPrototype(session,identity,pin,io);
 assert.throws(()=>transport.sendPayment('{}'),/non vérifiée/);assert.throws(()=>transport.sendOldDebt('{}'),/non vérifiée/);assert.equal(calls.length,0);
 await transport.verifyServer(identity,transport.check);await transport.fetchReference();await transport.sendPayment('{}');await transport.sendOldDebt('{}');assert.equal(calls.length,4);assert.match(calls[3],/day-invoice-old-debt$/);
 assert.throws(()=>transport.sendSource('autre','{}'),/Type/);
 current=false;assert.throws(()=>transport.sendPayment('{}'),/Session expirée/);assert.equal(calls.length,4);
});
test('lignée différente, absence de pin et HTTP non autorisé bloquent avant écriture',async()=>{
 let calls=0;const io={now:()=>now,isCurrentSession:()=>true,request:async()=>{calls++;return {ok:true,status:200,json:async()=>({version:1,commercialId:identity.commercialId,lineageId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'})};}};
 const noPin=createDayInvoiceTransportPrototype(session,identity,null,{...io,allowPrivateHttp:true});await assert.rejects(noPin.verifyServer(identity,noPin.check),/Lignée préalable/);assert.equal(calls,0);
 const noHttp=createDayInvoiceTransportPrototype(session,identity,pin,io);await assert.rejects(noHttp.verifyServer(identity,noHttp.check),/HTTPS/);assert.equal(calls,0);
 const wrong=createDayInvoiceTransportPrototype(session,identity,pin,{...io,allowPrivateHttp:true});await assert.rejects(wrong.verifyServer(identity,wrong.check),/incohérente/);assert.throws(()=>wrong.sendPayment('{}'),/non vérifiée/);assert.equal(calls,1);
});
test('expiration pendant la réponse et refus 401 ne peuvent libérer un accusé',async()=>{
 let current=true,unauthorized=false;const io={now:()=>now,isCurrentSession:()=>current,allowPrivateHttp:true,onUnauthorized:()=>{unauthorized=true;},request:async(url:string)=>url.endsWith('/server-lineage')?{ok:true,status:200,json:async()=>({version:1,commercialId:identity.commercialId,lineageId})}:{ok:true,status:200,json:async()=>{current=false;return {status:'received'};}}};
 const t=createDayInvoiceTransportPrototype(session,identity,pin,io);await t.verifyServer(identity,t.check);const response=await t.sendPayment('{}');await assert.rejects(response.json(),/Session expirée/);
 current=true;const unauth=createDayInvoiceTransportPrototype(session,identity,pin,{...io,request:async()=>({ok:false,status:401,json:async()=>({})})});await assert.rejects(unauth.verifyServer(identity,unauth.check),/Session refusée/);assert.equal(unauthorized,true);assert.throws(()=>unauth.check(),/Session expirée/);
});
