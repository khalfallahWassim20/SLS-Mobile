import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fetchServerLineage,compareLineagePins} from '../../../apps/mobile/server-lineage-proof.js';

test('preuve de lignée : session HTTPS vérifiée, pas de première confiance silencieuse',async()=>{
 const commercialId=randomUUID(),lineageId=randomUUID();
 const session={id:commercialId,name:'Commercial',serverOrigin:'https://new.example',token:'test',expiresAt:new Date(Date.now()+60000).toISOString()};
 let url='',authorization='';
 const candidate=await fetchServerLineage(session,async(u,o)=>{url=u;authorization=o.headers.Authorization;return {ok:true,status:200,json:async()=>({version:1,commercialId,lineageId})};});
 assert.equal(url,'https://new.example/api/mobile/identified/server-lineage');assert.equal(authorization,'Bearer test');
 const bound={commercialId,serverOrigin:'https://old.example'},pin={...bound,lineageId};
 assert.doesNotThrow(()=>compareLineagePins(bound,pin,candidate));
 assert.throws(()=>compareLineagePins(bound,null,candidate),/rapprochement/);
 assert.throws(()=>compareLineagePins(bound,{...pin,lineageId:randomUUID()},candidate),/rapprochement/);
 assert.throws(()=>compareLineagePins(bound,pin,{...candidate,commercialId:randomUUID()}),/rapprochement/);
 assert.throws(()=>compareLineagePins(bound,pin,{...candidate,serverOrigin:'http://new.example'}),/rapprochement/);
 await assert.rejects(fetchServerLineage({...session,serverOrigin:'http://new.example'},async()=>{throw Error('ne doit pas appeler');}),/HTTPS/);
 await assert.rejects(fetchServerLineage(session,async()=>({ok:true,status:200,json:async()=>({version:1,commercialId:randomUUID(),lineageId})})),/invalide/);
 await assert.rejects(fetchServerLineage({...session,expiresAt:new Date(Date.now()-1000).toISOString()},async()=>{throw Error('ne doit pas appeler');}),/expirée|valide/);
});

test('HTTP privé : opt-in explicite, adresses non privées refusées',async()=>{
 const {isPrivateHttpOrigin}=await import('../../../apps/mobile/private-api-origin.js');
 for(const x of ['http://192.168.100.23:3001','http://10.2.3.4','http://172.31.9.5'])assert.equal(isPrivateHttpOrigin(x),true);
 for(const x of ['http://172.32.1.1','http://8.8.8.8','http://example.com','http://127.0.0.1','http://192.168.1.1/path','https://192.168.1.1'])assert.equal(isPrivateHttpOrigin(x),false);
 const id=randomUUID(),lineageId=randomUUID(),session={id,name:'Test',serverOrigin:'http://192.168.100.23:3001',token:'test',expiresAt:new Date(Date.now()+60000).toISOString()};
 const request=async()=>({ok:true,status:200,json:async()=>({version:1,commercialId:id,lineageId})});
 await assert.rejects(fetchServerLineage(session,request),/HTTPS/);
 assert.equal((await fetchServerLineage(session,request,true)).lineageId,lineageId);
});
