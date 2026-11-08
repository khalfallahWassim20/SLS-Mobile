import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import express from 'express';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial} from '../../../apps/api/src/commercials.js';
import {changeTourClosure} from '../../../apps/api/src/tour-closure-store.js';
import {identifiedAdminReadRoutes} from '../../../apps/api/src/identified-admin-read.js';

test('lecture identifiée protégée par middleware admin et historique par journée',async()=>{
 const db=new PGlite();
 try {
  await db.exec(schemaSql);const conn={query:(sql:string,params?:unknown[])=>db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>conn,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  const c=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});
  await changeTourClosure(pool,c.id,'2026-11-10','close',{id:c.id,role:'commercial'},0);
  await changeTourClosure(pool,c.id,'2026-11-10','reopen',{id:'admin',role:'admin'},1);
  const app=express();app.use('/read',(req,res,next)=>{if(req.get('Authorization')!=='Bearer admin-test'){res.sendStatus(401);return;}next();},identifiedAdminReadRoutes(pool));
  const server=app.listen(0,'127.0.0.1');
  try {
   await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
   const address=server.address();if(!address || typeof address==='string')throw Error('Adresse indisponible');
   const base=`http://127.0.0.1:${address.port}/read`,headers={Authorization:'Bearer admin-test'};
   assert.equal((await fetch(`${base}/${c.id}/2026-11-10`)).status,401);
   assert.equal((await fetch(`${base}/bad/2026-11-10`,{headers})).status,400);
   assert.equal((await fetch(`${base}/${c.id}/2026-02-30`,{headers})).status,400);
   assert.equal((await fetch(`${base}/${randomUUID()}/2026-11-10`,{headers})).status,404);
   const response=await fetch(`${base}/${c.id}/2026-11-10`,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
   const data=await response.json();assert.equal(data.closure.status,'open');assert.equal(data.closure.version,2);
   assert.deepEqual(data.closureEvents.map((x:any)=>[x.action,x.actorRole,x.version]),[['reopen','admin',2],['close','commercial',1]]);
   assert.equal((await (await fetch(`${base}/${c.id}/2026-11-11`,{headers})).json()).closureEvents.length,0);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
 } finally {await db.close();}
});
