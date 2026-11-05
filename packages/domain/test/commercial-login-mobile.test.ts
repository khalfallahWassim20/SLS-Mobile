import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testCommercialLogin} from '../../../apps/mobile/commercial-login.js';

test('test mobile : identité vérifiée côté serveur sans conserver le jeton',async()=>{
 const calls:{url:string;options:any}[]=[];
 const send=async(url:string,options:any)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>calls.length===1?{token:'test-token',commercial:{name:'Ne pas utiliser'}}:{commercial:{id:'a1000000-0000-4000-8000-000000000001',name:'Commercial fictif'}}};};
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
 let count=0;const revoked=async()=>({ok:++count===1,status:401,json:async()=>({token:'temp'})});
 await assert.rejects(testCommercialLogin('http://192.168.1.10:3001','demo','fictif',revoked),/refusée/);
});
