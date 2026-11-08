import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import express from 'express';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saleHistoryRoutes} from '../../../apps/api/src/sale-history.js';

test('historique admin : authentification, anciennes et nouvelles versions, remboursement',async()=>{
 const db=new PGlite();
 try {
  await db.exec(schemaSql);const conn={query:(sql:string,params?:unknown[])=>db.query(sql,params),release:()=>{}};const pool={query:conn.query,connect:async()=>conn} as unknown as Pool;
  const client=randomUUID(),commercial=randomUUID(),sale=randomUUID();
  await db.query('INSERT INTO clients(id,name) VALUES($1,$2)',[client,'Client']);
  await db.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercial,'Commercial']);
  const payload=(total:number,paid:number,refund:number,recordedAt?:string)=>({sale:{clientId:client,clientName:'Client',createdAt:'2026-11-10T09:00:00.000Z',total,paid,remaining:Math.max(0,total-paid),lines:[]},refund,...(recordedAt?{recordedAt}:{})});
  await db.query('INSERT INTO demo_sale_events(operation_id,sale_id,version,client_id,payload,payload_hash) VALUES($1,$2,1,$3,$4,$5)',[randomUUID(),sale,client,JSON.stringify(payload(100000,100000,0)),'a']);
  await db.query('INSERT INTO identified_sale_events(operation_id,sale_id,version,client_id,commercial_id,journal_date,payload,payload_hash) VALUES($1,$2,2,$3,$4,$5,$6,$7)',[randomUUID(),sale,client,commercial,'2026-11-10',JSON.stringify(payload(60000,60000,40000,'2026-11-10T10:00:00.000Z')),'b']);
  const app=express();app.use('/sales',(req,res,next)=>{if(req.get('Authorization')!=='Bearer admin-test'){res.sendStatus(401);return;}next()},saleHistoryRoutes(pool));
  const server=app.listen(0,'127.0.0.1');
  try {
   await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});
   const address=server.address();if(!address||typeof address==='string')throw Error('Serveur indisponible');
   const base=`http://127.0.0.1:${address.port}/sales`, headers={Authorization:'Bearer admin-test'};
   assert.equal((await fetch(`${base}/${sale}/history`)).status,401);
   assert.equal((await fetch(`${base}/invalide/history`,{headers})).status,400);
   assert.equal((await fetch(`${base}/${randomUUID()}/history`,{headers})).status,404);
   const old=await (await fetch(`${base}/${sale}/history`,{headers})).json();assert.equal(old.versions.length,1);assert.equal(old.versions[0].commercialName,null);assert.equal(old.versions[0].recordedAt,null);
   await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
   const response=await fetch(`${base}/${sale}/history`,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
   const data=await response.json();assert.equal(data.truncated,false);assert.deepEqual(data.versions.map((v:any)=>v.version),[2,1]);assert.equal(data.versions[0].commercialName,'Commercial');assert.equal(data.versions[0].refund,40000);assert.equal(data.versions[0].recordedAt,'2026-11-10T10:00:00.000Z');
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
 } finally {await db.close();}
});
