import {test} from 'node:test';
import assert from 'node:assert/strict';
import {creditBridgeAvailable,creditBridgeMode} from '../../../apps/mobile/credit-server-capabilities.js';

test('découverte du pont : réponse authentifiée et identité exacte uniquement',async()=>{
 const session={id:'11111111-1111-4111-8111-111111111111',name:'Commercial',serverOrigin:'http://192.168.1.20:3001',token:'jeton',expiresAt:new Date(Date.now()+60000).toISOString()};
 const good={version:1,commercialId:session.id,creditBridgeTestOnly:true};let calls=0;
 const reply=(body:unknown,ok=true)=>async(url:string,options:{method:string;headers:Record<string,string>})=>{calls++;assert.equal(url,session.serverOrigin+'/api/mobile/identified/capabilities');assert.equal(options.headers.Authorization,'Bearer jeton');return {ok,json:async()=>body};};
 assert.equal(await creditBridgeAvailable(session,reply(good)),true);
 assert.equal(await creditBridgeAvailable(session,reply({...good,creditBridgeTestOnly:false})),false);
 assert.equal(await creditBridgeAvailable(session,reply({...good,commercialId:'autre'})),false);
 assert.equal(await creditBridgeAvailable(session,reply({...good,version:2})),false);
 assert.equal(await creditBridgeAvailable(session,reply(good,false)),false);
 assert.equal(await creditBridgeAvailable(session,async()=>{throw Error('hors ligne');}),false);
 assert.equal(await creditBridgeAvailable({...session,expiresAt:new Date(Date.now()-1000).toISOString()},reply(good)),false);
 assert.equal(calls,5);
});

test('pont : le mode annoncé (essai ou pilote) vient du serveur authentifié',async()=>{
 const session={id:'11111111-1111-4111-8111-111111111111',name:'Commercial',serverOrigin:'https://sls.example.test',token:'jeton',expiresAt:new Date(Date.now()+60000).toISOString()};
 const reply=(body:unknown)=>async()=>({ok:true,json:async()=>body});const base={version:1,commercialId:session.id,creditBridgeTestOnly:true};
 assert.equal(await creditBridgeMode(session,reply({...base,creditMode:'pilot'})),'pilot');
 assert.equal(await creditBridgeMode(session,reply({...base,creditMode:'test'})),'test');
 assert.equal(await creditBridgeMode(session,reply(base)),'test');
 assert.equal(await creditBridgeMode(session,reply({...base,creditMode:'production'})),null);
 assert.equal(await creditBridgeMode(session,reply({...base,creditBridgeTestOnly:false,creditMode:'pilot'})),null);
 assert.equal(await creditBridgeAvailable(session,reply({...base,creditMode:'pilot'})),true);
});
