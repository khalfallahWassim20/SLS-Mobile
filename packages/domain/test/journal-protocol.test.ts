import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJournalSnapshot, journalSnapshotHash, validateJournalTransition } from '../../../apps/api/src/journal-protocol.js';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const invoice = { id:uuid(1), journalDate:'2026-11-04', clientId:uuid(2), clientName:'Client démo', sector:'Gabès', amount:600000, createdAt:'2026-11-04T09:00:00.000Z' };
const receipt = { id:uuid(3), preInvoiceId:invoice.id, clientId:invoice.clientId, journalDate:invoice.journalDate, createdAt:'2026-11-04T10:00:00.000Z', prePaid:0, oldDebtPaid:300000, creditFull:true, mode:'Espèces', chequeNumber:'', chequeBank:'', chequeDue:'', oldDebtLimitAtStart:1000000 };
const event = {operationId:uuid(4), version:1, invoice, receipts:[receipt]};
test('instantané valide et empreinte stable après validation', () => {
 const first = parseJournalSnapshot(event);
 assert.equal(journalSnapshotHash(first),journalSnapshotHash(parseJournalSnapshot(JSON.parse(JSON.stringify(event)))));
 validateJournalTransition(null,first);
 const next = parseJournalSnapshot({...event,operationId:uuid(5),version:2,receipts:[receipt,{...receipt,id:uuid(6),creditFull:false,oldDebtPaid:0,prePaid:200000}]});
 validateJournalTransition(first,next);
 assert.notEqual(journalSnapshotHash(first),journalSnapshotHash(next));
});
test('rejette montants, rattachements, dates et chèques invalides', () => {
 const invalid = (r: object) => ({...event,receipts:[{...receipt,...r}]});
 assert.throws(()=>parseJournalSnapshot(invalid({oldDebtPaid:1000001})));
 assert.throws(()=>parseJournalSnapshot(invalid({prePaid:200000})));
 assert.throws(()=>parseJournalSnapshot(invalid({clientId:uuid(8)})));
 assert.throws(()=>parseJournalSnapshot(invalid({mode:'Chèque'})));
 assert.throws(()=>parseJournalSnapshot({...event,invoice:{...invoice,journalDate:'2026-02-30'}}));
 assert.throws(()=>parseJournalSnapshot({...event,receipts:[receipt,receipt]}));
 assert.throws(()=>parseJournalSnapshot({...event,unexpected:true}));
});
test('transition empêche les réécritures et les versions manquantes', () => {
 const first=parseJournalSnapshot(event);
 const transition=(next: object) => validateJournalTransition(first,parseJournalSnapshot({...event,operationId:uuid(5),version:2,...next}));
 assert.throws(()=>validateJournalTransition(null,parseJournalSnapshot({...event,version:2})));
 assert.throws(()=>transition({version:3}));
 assert.throws(()=>transition({receipts:[]}));
 assert.throws(()=>transition({invoice:{...invoice,amount:700000}}));
 assert.throws(()=>transition({receipts:[{...receipt,oldDebtPaid:200000},{...receipt,id:uuid(6),creditFull:false,oldDebtPaid:0,prePaid:100000}]}));
 assert.throws(()=>transition({receipts:[receipt,{...receipt,id:uuid(6),creditFull:false,oldDebtPaid:0,prePaid:100000,oldDebtLimitAtStart:900000}]}));
});

test('stockage transactionnel : création, accusé répété et conflit', async () => {
 const { storeJournalSnapshot, JournalConflict } = await import('../../../apps/api/src/journal-store.js');
 const { Pool } = await import('pg');
 // Simule le pilote ; ces tests ne remplacent pas un test sur PostgreSQL réel.
 const calls: string[] = [];
 let priorHash: string | undefined;
 const fake = { connect: async () => ({
   query: async (sql: string, params?: unknown[]) => {
     calls.push(sql);
     if (sql.startsWith('SELECT payload_hash')) return {rows: priorHash ? [{payload_hash:priorHash}] : []};
     if (sql.startsWith('SELECT id,client_id')) return {rows:[]};
     if (sql.startsWith('SELECT payload FROM')) return {rows:[]};
     if (sql.startsWith('SELECT id FROM clients')) return {rows:[{id:invoice.clientId}]};
     if (sql.startsWith('SELECT invoice_id')) return {rows:[{invoice_id:invoice.id}]};
     return {rows:[]};
   }, release: () => { calls.push('RELEASE'); }
 }) } as unknown as InstanceType<typeof Pool>;
 assert.equal(await storeJournalSnapshot(fake,event),'received');
 assert.ok(calls.some(c=>c.startsWith('INSERT INTO demo_journal_events')));
 assert.deepEqual(calls.slice(-2),['COMMIT','RELEASE']);
 calls.length=0; priorHash=journalSnapshotHash(parseJournalSnapshot(event));
 assert.equal(await storeJournalSnapshot(fake,event),'duplicate');
 assert.ok(!calls.some(c=>c.startsWith('INSERT INTO demo_journal_events')));
 calls.length=0; priorHash='different';
 await assert.rejects(storeJournalSnapshot(fake,event),JournalConflict);
 assert.deepEqual(calls.slice(-2),['ROLLBACK','RELEASE']);
});

test('migration et stockage sur moteur PostgreSQL intégré, sans test de concurrence', async () => {
 const { PGlite } = await import('@electric-sql/pglite');
 const { schemaSql } = await import('../../../apps/api/src/schema.js');
 const { storeJournalSnapshot, JournalConflict } = await import('../../../apps/api/src/journal-store.js');
 const { Pool } = await import('pg');
 const db = new PGlite();
 try {
  await db.exec(schemaSql); await db.exec(schemaSql);
  await db.query('INSERT INTO clients(id,name) VALUES($1,$2)',[invoice.clientId,invoice.clientName]);
  // PGlite est mono-connexion : les verrous et les requêtes concurrentes sont à vérifier sur PostgreSQL réseau.
  const client = {query: (sql: string, params?: unknown[]) => sql.startsWith('SELECT pg_advisory_xact_lock') ? Promise.resolve({rows:[]}) : db.query(sql,params), release: () => {}};
  const pool = {connect:async()=>client} as unknown as InstanceType<typeof Pool>;
  assert.equal(await storeJournalSnapshot(pool,event),'received');
  assert.equal(await storeJournalSnapshot(pool,event),'duplicate');
  await assert.rejects(storeJournalSnapshot(pool,{...event,invoice:{...invoice,amount:700000}}),JournalConflict);
  const second={...event,operationId:uuid(5),version:2,receipts:[receipt,{...receipt,id:uuid(6),creditFull:false,oldDebtPaid:0,prePaid:200000}]};
  assert.equal(await storeJournalSnapshot(pool,second),'received');
  await assert.rejects(storeJournalSnapshot(pool,{...event,operationId:uuid(7),invoice:{...invoice,id:uuid(8)},receipts:[]}),JournalConflict);
  const result=await db.query('SELECT version FROM demo_journal_events ORDER BY version');
  assert.deepEqual(result.rows.map((r:any)=>r.version),[1,2]);
  const express=(await import('express')).default;
  const {experimentalJournalRoutes}=await import('../../../apps/api/src/journal-routes.js');
  const app=express(); app.use(express.json());
  app.use('/journal', (req,res,next) => { if(req.headers.authorization !== 'Bearer test-admin') { res.sendStatus(401); return; } next(); },experimentalJournalRoutes({ ...pool, query:(sql:string,params?:unknown[])=>db.query(sql,params) } as unknown as InstanceType<typeof Pool>,true));
  app.use('/disabled',experimentalJournalRoutes(pool,false));
  const server=app.listen(0,'127.0.0.1');
  try {
   await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
   const addr=server.address(); if (!addr || typeof addr === 'string') throw Error('Adresse de test indisponible');
   const base=`http://127.0.0.1:${addr.port}`, headers={'Content-Type':'application/json',Authorization:'Bearer test-admin'};
   assert.equal((await fetch(base+'/journal')).status,401);
   assert.equal((await fetch(base+'/disabled')).status,404);
   const fresh={operationId:uuid(9),version:1,invoice:{...invoice,id:uuid(10),journalDate:'2026-11-05'},receipts:[]};
   assert.equal((await fetch(base+'/journal',{method:'POST',headers,body:JSON.stringify(fresh)})).status,201);
   const duplicate=await fetch(base+'/journal',{method:'POST',headers,body:JSON.stringify(event)});
   assert.equal(duplicate.status,200); assert.equal((await duplicate.json()).status,'duplicate');
   assert.equal((await fetch(base+'/journal',{method:'POST',headers,body:JSON.stringify({...event,invoice:{...invoice,amount:700000}})})).status,409);
   assert.equal((await fetch(base+'/journal',{method:'POST',headers,body:'{}'})).status,400);
   const listing=await fetch(base+'/journal',{headers}); assert.equal(listing.status,200);
   const data=await listing.json(); assert.equal(data.items.length,2); assert.ok(data.items.some((item:any)=>item.version===2)); assert.match(data.warning,/pas inclus/i);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
 } finally { await db.close(); }
});
