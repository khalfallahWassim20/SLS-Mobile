import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import express from 'express';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {identifiedCommercialRoutes,identifiedAdminRoutes} from '../../../apps/api/src/identified-tour-routes.js';

test('routeurs identifiés : mode verrouillé par défaut, activé uniquement après bascule test',async()=>{
 const db=new PGlite(),secret='secret fictif suffisamment long';
 try {
  await db.exec(schemaSql);const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>conn,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  const c=await saveCommercial(pool,'admin',{name:'Fictif',active:true});await setCommercialCredentials(pool,'admin',c.id,{login:'fictif',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'fictif',password:'mot de passe fictif'});assert.ok(session);
  const app=express();app.use(express.json());app.use('/commercial',identifiedCommercialRoutes(pool,secret));
  app.use('/admin',identifiedAdminRoutes(pool,(req,res,next)=>{if(req.get('Authorization')!=='Bearer admin'){res.sendStatus(401);return}next()},'admin'));
  const server=app.listen(0,'127.0.0.1');
  try {
   await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});
   const addr=server.address();if(!addr||typeof addr==='string')throw Error('Adresse invalide');const origin=`http://127.0.0.1:${addr.port}`;
   const headers={'Content-Type':'application/json',Authorization:'Bearer '+session.token};
   const close={requestId:randomUUID(),day:'2026-11-10',expectedVersion:0};
   const post=(path:string,body:unknown,h=headers)=>fetch(origin+path,{method:'POST',headers:h,body:JSON.stringify(body)});
   assert.equal((await fetch(origin+'/commercial/reference',{headers})).status,409);
   assert.equal((await post('/commercial/close',close)).status,409);
   assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM tour_closure_events')).rows[0].n,0);
   // Activation simulée uniquement dans la base temporaire, aucun endpoint ne la réalise.
   await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
   assert.equal((await fetch(origin+'/commercial/reference',{headers})).status,200);
   const details=await (await fetch(origin+'/commercial/day/2026-11-10/details',{headers})).json();assert.equal('closureEvents' in details,false);
   assert.equal((await post('/commercial/close',close)).status,201);
   const reopen={requestId:randomUUID(),day:close.day,expectedVersion:1};
   assert.equal((await post(`/admin/${c.id}/reopen`,reopen)).status,401);
   assert.equal((await post(`/admin/${c.id}/reopen`,reopen,{'Content-Type':'application/json',Authorization:'Bearer admin'})).status,201);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
 } finally {await db.close();}
});
