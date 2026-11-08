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

test('API de clôture isolée : rôles, écriture, réouverture et accusé perdu',async()=>{
 const db=new PGlite(),secret='secret fictif suffisamment long pour le test';
 try {
  await db.exec(schemaSql);await db.exec(schemaSql);
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={query:(sql:string,params?:unknown[])=>db.query(sql,params),connect:async()=>conn} as unknown as Pool;
  const c=await saveCommercial(pool,'admin',{name:'Fictif',active:true});
  await setCommercialCredentials(pool,'admin',c.id,{login:'commercial.test',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'commercial.test',password:'mot de passe fictif'});assert.ok(session);
  const clientId=randomUUID();await db.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Client fictif']);
  const app=express();app.use(express.json());app.use('/commercial',identifiedCommercialRoutes(pool,secret,{enforceMode:false}));
  app.use('/admin',identifiedAdminRoutes(pool,(req,res,next)=>{if(req.get('Authorization')!=='Bearer admin-test'){res.sendStatus(401);return;}next();},'admin-test',{enforceMode:false}));
  const server=app.listen(0,'127.0.0.1');
  try {
   await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
   const addr=server.address();if(!addr || typeof addr==='string')throw Error('Adresse invalide');
   const base=`http://127.0.0.1:${addr.port}`,headers={'Content-Type':'application/json',Authorization:`Bearer ${session.token}`};
   const adminHeaders={'Content-Type':'application/json',Authorization:'Bearer admin-test'},day='2026-11-10';
   const get=async()=>fetch(`${base}/commercial/day/${day}`,{headers});
   const post=(path:string,body:unknown,h=headers)=>fetch(base+path,{method:'POST',headers:h,body:JSON.stringify(body)});
   assert.equal((await fetch(base+`/commercial/day/${day}`)).status,401);
   const initial=await get();assert.equal(initial.status,200);assert.equal((await initial.json()).version,0);
   assert.equal(initial.headers.get('cache-control'),'no-store');
   const invoice={id:randomUUID(),clientId,clientName:'Client fictif',journalDate:day,createdAt:'2026-11-10T09:00:00.000Z',sector:'',amount:600000};
   const first={operationId:randomUUID(),version:1,invoice,receipts:[]};
   assert.equal((await post('/commercial/journal',first)).status,201);
   const close={requestId:randomUUID(),day,expectedVersion:0};
   const closeResult=await post('/commercial/close',close);assert.equal(closeResult.status,201);const firstAck=await closeResult.json();assert.equal(firstAck.action,'close');assert.equal(firstAck.commercialId,c.id);
   const repeat=await post('/commercial/close',close);assert.equal(repeat.status,200);assert.equal((await repeat.json()).status,'duplicate');
   assert.equal((await post('/commercial/close',{...close,expectedVersion:1})).status,409);
   const receipt={id:randomUUID(),preInvoiceId:invoice.id,clientId,journalDate:day,createdAt:'2026-11-10T10:00:00.000Z',prePaid:200000,oldDebtPaid:0,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:0};
   const second={operationId:randomUUID(),version:2,invoice,receipts:[receipt]};
   assert.equal((await post('/commercial/journal',first)).status,200);
   const blocked=await post('/commercial/journal',second);assert.equal(blocked.status,409);const conflict=await blocked.json();assert.equal(conflict.code,'TOUR_DAY_CLOSED');assert.equal(conflict.day,day);assert.equal(conflict.commercialId,c.id);
   const reopen={requestId:randomUUID(),day,expectedVersion:1};
   assert.equal((await post(`/admin/${c.id}/reopen`,reopen)).status,401);
   assert.equal((await post(`/admin/${c.id}/reopen`,reopen,adminHeaders)).status,201);
   assert.equal((await post(`/admin/${c.id}/reopen`,reopen,adminHeaders)).status,200);
   // Le renvoi de l'ancien accusé ne referme pas une journée rouverte.
   assert.equal((await post('/commercial/close',close)).status,200);
   const state=await (await get()).json();assert.equal(state.status,'open');assert.equal(state.version,2);
   assert.equal((await post('/commercial/journal',second)).status,201);
   const rows=await db.query<{n:number}>('SELECT count(*)::int AS n FROM tour_closure_events');assert.equal(rows.rows[0].n,2);
   await saveCommercial(pool,'admin',{name:'Fictif',active:false},c.id);
   assert.equal((await post('/commercial/close',{requestId:randomUUID(),day,expectedVersion:2})).status,401);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
 } finally {await db.close();}
});
