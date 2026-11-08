import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uploadIdentifiedOperations,ClosedDaySyncError,type IdentifiedEntry} from '../../../apps/mobile/identified-upload.js';
const id='a1000000-0000-4000-8000-000000000001',sale='a1000000-0000-4000-8000-000000000002',op='a1000000-0000-4000-8000-000000000003',other='a1000000-0000-4000-8000-000000000004',url='http://192.168.1.10:3001';
const identity={commercialId:id,serverOrigin:url};
const entry:IdentifiedEntry={operationId:op,entityId:sale,commercialId:id,kind:'sale',recordedAt:'2026-11-10T09:00:00.000Z',payload:JSON.stringify({operationId:op,saleId:sale,version:1,sale:{syncSaleId:sale,syncVersion:1}})};
test('envoi identifié : valide identité et toutes les opérations avant tout envoi',async()=>{
 let sent=0;const send=async()=>{sent++;return {ok:true,status:200,json:async()=>({status:'received',operationId:op})}},ack=async()=>{};
 await assert.rejects(uploadIdentifiedOperations([entry],identity,{...identity,commercialId:other},send,ack),/Session/);
 await assert.rejects(uploadIdentifiedOperations([entry,{...entry,operationId:other,commercialId:other}],identity,identity,send,ack),/identité/);
 assert.equal(sent,0);
 await assert.rejects(uploadIdentifiedOperations([{...entry,recordedAt:''}],identity,identity,send,ack),/Date/);
});
test('envoi identifié : garde UUID et date en cas de panne et vérifie l’accusé',async()=>{
 const acks:string[]=[],seen:string[]=[];
 const ok=async(path:string,payload:string)=>{assert.equal(path,'sales');const body=JSON.parse(payload);seen.push(body.recordedAt);return {ok:true,status:201,json:async()=>({status:'received',operationId:op})}};
 await assert.rejects(uploadIdentifiedOperations([entry],identity,identity,async()=>{throw Error('coupure');},async x=>{acks.push(x)}),/coupure/);
 await assert.rejects(uploadIdentifiedOperations([entry],identity,identity,async()=>({ok:true,status:200,json:async()=>({status:'received',operationId:other})}),async x=>{acks.push(x)}),/Accusé/);
 assert.equal(acks.length,0);
 assert.equal(await uploadIdentifiedOperations([entry],identity,identity,ok,async x=>{acks.push(x)}),1);
 assert.deepEqual(seen,[entry.recordedAt]);assert.deepEqual(acks,[op]);
});

test('journée clôturée : accusés antérieurs seuls supprimés, refus repris sans changement',async()=>{
 const second={...entry,operationId:other,payload:JSON.stringify({...JSON.parse(entry.payload),operationId:other})};
 const acked:string[]=[];let calls=0;
 await assert.rejects(uploadIdentifiedOperations([entry,second],identity,identity,async()=>{
  calls++;return calls===1?{ok:true,status:201,json:async()=>({status:'received',operationId:op})}:{ok:false,status:409,json:async()=>({code:'TOUR_DAY_CLOSED',day:'2026-11-10',commercialId:id})};
 },async operationId=>{acked.push(operationId)}),e=>e instanceof ClosedDaySyncError && e.day==='2026-11-10' && e.commercialId===id);
 assert.deepEqual(acked,[op]);
 const bodies:string[]=[];
 assert.equal(await uploadIdentifiedOperations([second],identity,identity,async(_path,payload)=>{bodies.push(payload);return {ok:true,status:200,json:async()=>({status:'received',operationId:other})}},async operationId=>{acked.push(operationId)}),1);
 assert.equal(JSON.parse(bodies[0]).operationId,other);assert.deepEqual(acked,[op,other]);
});
test('un conflit générique ou des données de clôture invalides ne sont pas interprétés comme une clôture',async()=>{
 const acked:string[]=[];
 await assert.rejects(uploadIdentifiedOperations([entry],identity,identity,async()=>({ok:false,status:409,json:async()=>({code:'TOUR_DAY_CLOSED',day:'2026-02-30',commercialId:id,error:'Autre conflit'})}),async x=>{acked.push(x)}),e=> e instanceof Error && !(e instanceof ClosedDaySyncError) && e.message==='Autre conflit');
 assert.deepEqual(acked,[]);
});
