import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uploadDayInvoicePayments} from '../../../apps/mobile/day-invoice-upload.js';
const commercialId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',origin='https://example.test';
const identity={commercialId,serverOrigin:origin};
const mk=(sequence:number,id:string)=>({sequence,operationId:id,commercialId,serverOrigin:origin,payload:JSON.stringify({operationId:id,clientId:commercialId,day:'2026-01-01',recordedAt:'2026-01-01T12:00:00.000Z',amount:500,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',version:1,total:600000,declare:true},sales:[{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',version:1}]})});
const a=mk(1,'11111111-1111-4111-8111-111111111111'),b=mk(2,'22222222-2222-4222-8222-222222222222');
const response=(operationId:string,status='received')=>({ok:true,status:200,json:async()=>({status,operationId})});
test('réponse perdue : reprendre exactement sans suppression prématurée ni doublon',async()=>{
 const pending=[a,b],received=new Set<string>();let lost=true;
 const send=async(payload:string)=>{const id=JSON.parse(payload).operationId,duplicate=received.has(id);received.add(id);if(lost){lost=false;throw Error('réponse perdue');}return response(id,duplicate?'duplicate':'received');};
 const ack=async(entry:typeof a)=>{const i=pending.findIndex(e=>e.operationId===entry.operationId);pending.splice(i,1);};
 await assert.rejects(uploadDayInvoicePayments([...pending],identity,identity,send,ack),/perdue/);
 assert.equal(pending.length,2);
 assert.equal(await uploadDayInvoicePayments([...pending],identity,identity,send,ack),2);
 assert.equal(pending.length,0);assert.equal(received.size,2);
});
test('identité, file, réponse et accusé sont vérifiés avant suppression',async()=>{
 let sends=0,acks=0;const send=async()=>{sends++;return response('autre');},ack=async()=>{acks++;};
 await assert.rejects(uploadDayInvoicePayments([a],identity,{...identity,serverOrigin:'https://other.test'},send,ack),/serveur/);
 await assert.rejects(uploadDayInvoicePayments([b,a],identity,identity,send,ack),/File/);
 assert.equal(sends,0);
 await assert.rejects(uploadDayInvoicePayments([a,b],identity,identity,send,ack),/Accusé/);
 assert.equal(sends,1);assert.equal(acks,0);
 await assert.rejects(uploadDayInvoicePayments([a,b],identity,identity,async()=>response(a.operationId),async()=>{throw Error('SQLite');}),/SQLite/);
});
test('conflit serveur ou contenu inconnu : aucune opération supprimée',async()=>{
 let sends=0,acks=0;
 const conflict=async()=>{sends++;return {ok:false,status:409,json:async()=>({error:'Conflit de version'})};};
 await assert.rejects(uploadDayInvoicePayments([a,b],identity,identity,conflict,async()=>{acks++;}),/Conflit/);
 assert.equal(sends,1);assert.equal(acks,0);
 const extra={...a,payload:JSON.stringify({...JSON.parse(a.payload),unknown:true})};
 await assert.rejects(uploadDayInvoicePayments([extra],identity,identity,conflict,async()=>{acks++;}),/Contenu/);
 assert.equal(sends,1);assert.equal(acks,0);
});

test('la file doit appartenir à l’identité et au serveur vérifiés',async()=>{
 let sends=0;
 await assert.rejects(uploadDayInvoicePayments([{...a,serverOrigin:'https://other.test'}],identity,identity,async()=>{sends++;return response(a.operationId);},async()=>{}),/File/);
 assert.equal(sends,0);
});

test('une clôture serveur conserve son périmètre pour le rapprochement mobile',async()=>{
 const {ClosedDaySyncError}=await import('../../../apps/mobile/identified-upload.js');let acknowledged=false;
 const closed=async()=>({ok:false,status:409,json:async()=>({code:'TOUR_DAY_CLOSED',day:'2026-01-01',commercialId,error:'Journée clôturée'})});
 await assert.rejects(uploadDayInvoicePayments([a],identity,identity,closed,async()=>{acknowledged=true;}),(error:unknown)=>error instanceof ClosedDaySyncError&&error.day==='2026-01-01'&&error.commercialId===commercialId);
 assert.equal(acknowledged,false);
});
