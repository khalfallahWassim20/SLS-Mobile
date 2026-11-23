import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {identifiedCommercialRoutes} from '../../../apps/api/src/identified-tour-routes.js';

test('pilote d’avoirs : seul le commercial nommé obtient le pont et le protocole v5',async()=>{
 const db=new PGlite();let server:ReturnType<ReturnType<typeof express>['listen']>|undefined;
 try{
  await db.exec(schemaSql);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>conn,query:conn.query} as unknown as Pool,secret='secret fictif assez long pour les tests';
  const login=async(name:string,id:string)=>{const c=await saveCommercial(pool,'admin',{name,active:true});await setCommercialCredentials(pool,'admin',c.id,{login:id,password:'mot de passe fictif'});const s=await loginCommercial(pool,secret,{login:id,password:'mot de passe fictif'});assert.ok(s);return {id:c.id,token:s.token};};
  const pilot=await login('Pilote','pilote.test'),other=await login('Autre','autre.test'),clientId=randomUUID();
  const app=express();app.use(express.json());
  app.use('/pilot',identifiedCommercialRoutes(pool,secret,{allowCreditProtocol:true,creditPilotCommercialId:pilot.id.toUpperCase()}));
  app.use('/off',identifiedCommercialRoutes(pool,secret,{creditPilotCommercialId:pilot.id}));
  server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));
  const a=server.address();assert.ok(a&&typeof a!=='string');const url=`http://127.0.0.1:${a.port}`;
  const get=(path:string,who:{token:string},v5=false)=>fetch(url+path,{headers:{Authorization:`Bearer ${who.token}`,...(v5?{'X-SLS-Reference-Version':'5'}:{})}});
  assert.deepEqual(await (await get('/pilot/capabilities',pilot)).json(),{version:1,commercialId:pilot.id,creditBridgeTestOnly:true,creditMode:'pilot'});
  assert.deepEqual(await (await get('/pilot/capabilities',other)).json(),{version:1,commercialId:other.id,creditBridgeTestOnly:false});
  assert.deepEqual(await (await get('/off/capabilities',pilot)).json(),{version:1,commercialId:pilot.id,creditBridgeTestOnly:false});
  const forbidden=await get(`/pilot/credit-sources/${clientId}`,other,true);assert.equal(forbidden.status,403);
  const allowed=await get(`/pilot/credit-sources/${clientId}`,pilot,true);assert.notEqual(allowed.status,403);assert.notEqual(allowed.status,401);
  assert.equal((await fetch(`${url}/pilot/credit-sources/${clientId}`,{headers:{Authorization:'Bearer mauvais','X-SLS-Reference-Version':'5'}})).status,401);
 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await db.close();}
});
