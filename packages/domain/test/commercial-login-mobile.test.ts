import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testCommercialLogin,openCommercialSession,openBoundCommercialSession} from '../../../apps/mobile/commercial-login.js';

test('test mobile : identité vérifiée côté serveur sans conserver le jeton',async()=>{
 const calls:{url:string;options:any}[]=[];
 const send=async(url:string,options:any)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>calls.length===1?{token:'test-token',expiresAt:'2099-01-01T23:00:00.000Z',commercial:{name:'Ne pas utiliser'}}:{commercial:{id:'a1000000-0000-4000-8000-000000000001',name:'Commercial fictif'}}};};
 const result=await testCommercialLogin('http://192.168.1.10:3001','demo','fictif',send);
 assert.deepEqual(result,{id:'a1000000-0000-4000-8000-000000000001',name:'Commercial fictif'});
 assert.equal(calls[1].options.headers.Authorization,'Bearer test-token');
 assert.equal(JSON.stringify(result).includes('test-token'),false);
});
test('test mobile : refuse serveur invalide, erreur de connexion ou réponse invalide',async()=>{
 const fail=async()=>({ok:false,status:401,json:async()=>({})});
 await assert.rejects(testCommercialLogin('http://localhost:3001','demo','fictif',fail),/adresse réseau/i);
 await assert.rejects(testCommercialLogin('http://192.168.1.10:3001','demo','fictif',fail),/incorrect/);
 const invalid=async()=>({ok:true,status:200,json:async()=>({})});
 await assert.rejects(testCommercialLogin('http://192.168.1.10:3001','demo','fictif',invalid),/invalide/);
 let count=0;const revoked=async()=>({ok:++count===1,status:401,json:async()=>({token:'temp',expiresAt:'2099-01-01T23:00:00.000Z'})});
 await assert.rejects(testCommercialLogin('http://192.168.1.10:3001','demo','fictif',revoked),/refusée/);
});

test('session commerciale : origine, expiration et jeton obtenus après vérification',async()=>{
 let calls=0;
 const send=async()=>({ok:true,status:200,json:async()=>++calls===1?{token:'session-fictive',expiresAt:'2099-01-01T23:00:00.000Z'}:{commercial:{id:'a1000000-0000-4000-8000-000000000001',name:'Fictif'}}});
 const result=await openCommercialSession('http://192.168.1.10:3001/','demo','fictif',send);
 assert.deepEqual(result,{id:'a1000000-0000-4000-8000-000000000001',name:'Fictif',serverOrigin:'http://192.168.1.10:3001',token:'session-fictive',expiresAt:'2099-01-01T23:00:00.000Z'});
});

test('liaison : bloque toute autre origine et le repli HTTP avant l’envoi du mot de passe',async()=>{
 const id='a1000000-0000-4000-8000-000000000001';
 const bound={commercialId:id,serverOrigin:'https://api.example.test:3001'};let calls=0;
 const send=async()=>{calls++;return {ok:true,status:200,json:async()=>calls%2===1?{token:'test',expiresAt:'2099-01-01T23:00:00.000Z'}:{commercial:{id,name:'Fictif'}}};};
 for(const target of ['http://api.example.test:3001','https://other.example.test:3001','http://192.168.100.23:3001'])await assert.rejects(openBoundCommercialSession(target,'demo','fictif',send,async()=>bound),/aucun identifiant/);
 assert.equal(calls,0);
 await assert.rejects(openBoundCommercialSession(bound.serverOrigin,'demo','fictif',send,async()=>{throw Error('SQLite indisponible')}),/SQLite/);assert.equal(calls,0);
 const session=await openBoundCommercialSession(bound.serverOrigin,'demo','fictif',send,async()=>bound);assert.equal(session.id,id);assert.equal(calls,2);
});

test('liaison : refuse une autre identité ou une liaison modifiée avant toute lecture métier',async()=>{
 const id='a1000000-0000-4000-8000-000000000001',other='a1000000-0000-4000-8000-000000000002',origin='https://api.example.test';
 let calls=0;const send=async()=>({ok:true,status:200,json:async()=>++calls%2===1?{token:'test',expiresAt:'2099-01-01T23:00:00.000Z'}:{commercial:{id:other,name:'Autre'}}});
 await assert.rejects(openBoundCommercialSession(origin,'demo','fictif',send,async()=>({commercialId:id,serverOrigin:origin})),/autre commercial/);assert.equal(calls,2);
 let reads=0;await assert.rejects(openBoundCommercialSession(origin,'demo','fictif',send,async()=>++reads===1?null:{commercialId:id,serverOrigin:origin}),/liaison a changé/);assert.equal(calls,4);
});
