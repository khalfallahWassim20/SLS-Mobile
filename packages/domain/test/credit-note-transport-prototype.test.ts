import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCreditTransportPrototype} from '../../../apps/mobile/credit-note-transport-prototype.js';
function fixture(){
 const commercialId=randomUUID(),identity={commercialId,serverOrigin:'https://api.example.test'},now0=Date.parse('2026-11-08T10:00:00.000Z');let now=now0,unauthorized=0;
 const session={id:commercialId,name:'Fictif',serverOrigin:identity.serverOrigin,token:'jeton fictif',expiresAt:'2026-11-08T23:00:00.000Z'};
 const events:string[]=[],calls:{url:string;options:any}[]=[];let release:(()=>void)|null=null,block=false,status=200;
 const io={now:()=>now,onUnauthorized:()=>{unauthorized++},request:async(url:string,options:any)=>{calls.push({url,options});if(block)await new Promise<void>(r=>{release=r});return {status,ok:status===200,json:async()=>({clientId:'test',error:'Session refusée'})};},
  cacheReference:async()=>{events.push('reference')},cacheSources:async()=>{events.push('sources')},
  synchronize:async(_a:any,_b:any,transport:any)=>{await transport.fetchReference();const r=await transport.sendCredit('sales','{"operationId":"x"}');await r.json();events.push('sync');return {operations:0,credits:1}}};
 return {identity,session,events,calls,io,expire:()=>{now=Date.parse(session.expiresAt)},reject:()=>{status=401},unauthorized:()=>unauthorized,block:()=>{block=true},release:()=>{assert.ok(release);release();}};
}
test('transport v5 : routes fixes, session vérifiée, ordre et exclusion simultanée',async()=>{
 const f=fixture(),controller=createCreditTransportPrototype(f.session,f.identity,f.io),client=randomUUID();
 await controller.refreshSources(client);assert.deepEqual(f.events,['reference','sources']);assert.match(f.calls[0].url,/\/api\/mobile\/identified\/reference$/);assert.match(f.calls[1].url,new RegExp(`/credit-sources/${client}$`));
 assert.equal(f.calls[0].options.headers['X-SLS-Reference-Version'],'5');assert.equal(f.calls[0].options.headers.Authorization,'Bearer jeton fictif');
 assert.deepEqual(await controller.synchronize(),{operations:0,credits:1});assert.match(f.calls.at(-1)!.url,/credit-notes\/sales$/);
 f.block();const pending=controller.refreshReference();await assert.rejects(controller.refreshSources(client),/déjà en cours/);const other=createCreditTransportPrototype(f.session,f.identity,f.io);await assert.rejects(other.refreshReference(),/déjà en cours/);f.release();await pending;
});
test('transport v5 : identité, expiration et session refusée ne remplacent aucun cache',async()=>{
 const wrong=fixture(),controller=createCreditTransportPrototype(wrong.session,{...wrong.identity,commercialId:randomUUID()},wrong.io);
 await assert.rejects(controller.refreshReference(),/identité différente/);assert.equal(wrong.calls.length,0);
 const expired=fixture(),c=createCreditTransportPrototype(expired.session,expired.identity,expired.io);expired.block();const pending=c.refreshReference();expired.expire();expired.release();await assert.rejects(pending,/expirée/);assert.deepEqual(expired.events,[]);
 const refused=fixture(),d=createCreditTransportPrototype(refused.session,refused.identity,refused.io);refused.reject();await assert.rejects(d.refreshReference(),/Session refusée/);assert.equal(refused.unauthorized(),1);assert.deepEqual(refused.events,[]);
 await assert.rejects(d.refreshSources('non-uuid'),/Client invalide/);await assert.rejects(d.refreshReference(),/expirée/);assert.equal(refused.calls.length,1);
});
test('transport v5 : interdiction de routes arbitraires',async()=>{
 const f=fixture();f.io.synchronize=async(_a,_b,transport)=>{await assert.rejects(async()=>transport.sendOperation('../reference','{}'),/invalide/);await assert.rejects(async()=>transport.sendCredit('other','{}'),/invalide/);return {operations:0,credits:0};};
 const c=createCreditTransportPrototype(f.session,f.identity,f.io);await c.synchronize();assert.equal(f.calls.length,0);
});

test('session expirée au milieu du cache : transaction annulée et nouvelle tentative possible',async()=>{
 const f=fixture();let committed=0;
 f.io.cacheReference=async(_identity?:any,_verified?:any,_value?:any,guard?:()=>void)=>{let staged=committed;guard!();staged++;f.expire();guard!();committed=staged;};
 const controller=createCreditTransportPrototype(f.session,f.identity,f.io);
 await assert.rejects(controller.refreshReference(),/expirée/);assert.equal(committed,0);
 const fresh=fixture();await createCreditTransportPrototype(fresh.session,fresh.identity,fresh.io).refreshReference();assert.deepEqual(fresh.events,['reference']);
});
test('session et identité copiées : mutation extérieure ne redirige pas le jeton',async()=>{
 const f=fixture(),controller=createCreditTransportPrototype(f.session,f.identity,f.io);
 f.identity.serverOrigin='https://autre.example.test';f.session.serverOrigin='https://autre.example.test';f.session.token='autre jeton';
 await controller.refreshReference();assert.match(f.calls[0].url,/^https:\/\/api\.example\.test\//);assert.equal(f.calls[0].options.headers.Authorization,'Bearer jeton fictif');
});

test('transport v5 : date de clôture stricte et dépendances exigées',async()=>{
 const f=fixture(),controller=createCreditTransportPrototype(f.session,f.identity,f.io);
 await assert.rejects(controller.refreshDay('2026-02-30'),/Date de tournée invalide/);
 await assert.rejects(controller.closeDay('../close'),/Date de tournée invalide/);
 await assert.rejects(controller.closeDay('2026-11-08'),/Clôture v5 indisponible/);
 assert.equal(f.calls.length,0);
});

test('liaison v5 : référence authentifiée avant liaison et refus sans prise en charge',async()=>{
 const f=fixture();const noBinding=createCreditTransportPrototype(f.session,f.identity,f.io);await assert.rejects(noBinding.connect(),/Liaison v5 indisponible/);assert.equal(f.calls.length,0);
 let stored=false;const controller=createCreditTransportPrototype(f.session,f.identity,{...f.io,bindReference:async(id,verified,value,guard)=>{guard();assert.deepEqual(id,verified);assert.deepEqual(value,{clientId:'test',error:'Session refusée'});stored=true;guard();}});
 await controller.connect();assert.equal(stored,true);assert.match(f.calls[0].url,/\/reference$/);assert.equal(f.calls[0].options.headers['X-SLS-Reference-Version'],'5');
 const bad=fixture();bad.reject();let bound=false;const denied=createCreditTransportPrototype(bad.session,bad.identity,{...bad.io,bindReference:async()=>{bound=true;}});await assert.rejects(denied.connect(),/Session refusée/);assert.equal(bound,false);
});

test('déconnexion pendant une réponse v5 : aucun cache ni accusé validé',async()=>{
 const f=fixture();let active=true;const controller=createCreditTransportPrototype(f.session,f.identity,{...f.io,isCurrentSession:()=>active});
 f.block();const pending=controller.refreshReference();active=false;f.release();await assert.rejects(pending,/expirée|identité/);assert.deepEqual(f.events,[]);
 await assert.rejects(controller.synchronize(),/expirée|identité/);assert.equal(f.calls.length,1);
});
