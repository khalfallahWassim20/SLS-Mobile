import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {schemaSql} from '../../../apps/api/src/schema.js';

test('identité de base : stable après migration répétée, distincte entre bases',async()=>{
 const a=new PGlite(),b=new PGlite();
 try{
  await a.exec(schemaSql);await b.exec(schemaSql);
  const query='SELECT lineage_id::text AS id FROM server_lineage_identity WHERE id=1';
  const first=(await a.query<{id:string}>(query)).rows[0].id,other=(await b.query<{id:string}>(query)).rows[0].id;
  assert.match(first,/^[0-9a-f-]{36}$/);assert.notEqual(first,other);
  await a.exec(schemaSql);assert.equal((await a.query<{id:string}>(query)).rows[0].id,first);
 }finally{await a.close();await b.close();}
});

test('identité de base : accès réservé à une session commerciale valide',async()=>{
 const {randomUUID}=await import('node:crypto');const express=(await import('express')).default;
 const {saveCommercial,setCommercialCredentials}=await import('../../../apps/api/src/commercials.js');
 const {loginCommercial}=await import('../../../apps/api/src/commercial-session.js');
 const {identifiedCommercialRoutes}=await import('../../../apps/api/src/identified-tour-routes.js');
 const db=new PGlite();let server:ReturnType<ReturnType<typeof express>['listen']>|undefined;
 try{
  await db.exec(schemaSql);
  const connection={query:(sql:string,args?:unknown[])=>db.query(sql,args),release:()=>{}};
  const pool={query:connection.query,connect:async()=>connection} as unknown as import('pg').Pool;
  const c=await saveCommercial(pool,'admin',{name:'Test '+randomUUID(),active:true});await setCommercialCredentials(pool,'admin',c.id,{login:'server.id',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour les tests',session=await loginCommercial(pool,secret,{login:'server.id',password:'mot de passe fictif'});assert.ok(session);
  const app=express();app.use('/mobile',identifiedCommercialRoutes(pool,secret));server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}/mobile/server-lineage`;
  assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{Authorization:'Bearer incorrect'}})).status,401);
  const response=await fetch(url,{headers:{Authorization:`Bearer ${session.token}`}});assert.equal(response.status,200);assert.match(response.headers.get('cache-control')??'',/no-store/);
  const body=await response.json() as {version:number;commercialId:string;lineageId:string};assert.equal(body.version,1);assert.equal(body.commercialId,c.id);assert.equal(body.lineageId,(await db.query<{id:string}>('SELECT lineage_id::text AS id FROM server_lineage_identity')).rows[0].id);
 }finally{if(server)await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve()));await db.close();}
});
