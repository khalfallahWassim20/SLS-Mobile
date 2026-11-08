import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSecureSessionStore,validSession} from '../../../apps/mobile/secure-commercial-session.js';
const now=Date.parse('2026-11-08T12:00:00.000Z');
const identity={commercialId:'a1000000-0000-4000-8000-000000000001',serverOrigin:'http://192.168.1.10:3001'};
const session={id:identity.commercialId,name:'Fictif',serverOrigin:identity.serverOrigin,token:'token-test',expiresAt:'2026-11-08T23:00:00.000Z'};
function fake(){let value:string|null=null;return {getItemAsync:async()=>value,setItemAsync:async(_key:string,v:string)=>{value=v},deleteItemAsync:async()=>{value=null}};}
test('session sécurisée : restauration le jour même, puis expiration et identité vérifiée',async()=>{
 const storage=fake(),s=createSecureSessionStore(storage);await s.save(session);
 assert.deepEqual(await s.restore(identity,now),session);
 assert.equal(await s.restore(identity,Date.parse(session.expiresAt)),null);
 assert.equal(await s.restore(identity,now),null);
 await s.save(session);assert.equal(await s.restore({...identity,commercialId:'a1000000-0000-4000-8000-000000000002'},now),null);
 assert.equal(validSession(session,{...identity,serverOrigin:'http://192.168.1.11:3001'},now),false);
 assert.equal(validSession({...session,expiresAt:'invalid'},identity,now),false);
 assert.equal(validSession({...session,expiresAt:'2030-01-01T00:00:00.000Z'},identity,now),false);
});
test('suppression conditionnelle et sauvegarde sérialisée ne perdent pas la nouvelle session',async()=>{
 const storage=fake(),s=createSecureSessionStore(storage);await s.save(session);
 const next={...session,token:'nouveau-token'};
 await Promise.all([s.save(next),s.clearIfToken(session.token)]);
 assert.deepEqual(await s.restore(identity,now),next);
 await s.clear();assert.equal(await s.restore(identity,now),null);
});
