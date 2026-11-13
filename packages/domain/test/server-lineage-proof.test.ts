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
