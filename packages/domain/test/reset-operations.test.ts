import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {resetTestOperations} from '../../../apps/api/src/reset-test-operations.js';
import {resetLocalTestOperations} from '../../../apps/mobile/reset-test-operations.js';

test('nettoyage serveur : atomique, sans effacer référentiel, comptes, soldes initiaux ni audit',async()=>{
 const db=new PGlite();
 try {
  await db.exec(schemaSql);const client=randomUUID(),commercial=randomUUID(),article=randomUUID();
  await db.query('INSERT INTO clients(id,name,opening_balance,credit_limit) VALUES($1,$2,1000000,2000000)',[client,'Client fictif']);
  await db.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercial,'Commercial fictif']);
  await db.query('INSERT INTO commercial_credentials(commercial_id,login,password_hash) VALUES($1,$2,$3)',[commercial,'commercial','hash']);
  await db.query("INSERT INTO articles(id,code,name,purchase_ttc,sale_ttc) VALUES($1,'CODE','Article',100,200)",[article]);
  await db.query("UPDATE tour_sync_mode SET mode='identified'");
  await db.query("INSERT INTO tour_closures(commercial_id,journal_date,status,version,closed_at) VALUES($1,'2026-11-10','closed',1,now())",[commercial]);
  await db.query("INSERT INTO tour_closure_events(id,commercial_id,journal_date,action,actor_id,actor_role,occurred_at,version) VALUES($1,$2,'2026-11-10','close',$3,'commercial',now(),1)",[randomUUID(),commercial,commercial]);
  const inv=randomUUID();await db.query("INSERT INTO sync_journal_invoices(id,client_id,journal_date) VALUES($1,$2,'2026-11-10')",[inv,client]);
  await db.query("INSERT INTO sync_journal_events(operation_id,invoice_id,version,payload,payload_hash) VALUES($1,$2,1,'{}','hash')",[randomUUID(),inv]);
  await db.query("INSERT INTO demo_sale_events(operation_id,sale_id,version,client_id,payload,payload_hash) VALUES($1,$2,1,$3,'{}','hash')",[randomUUID(),randomUUID(),client]);
  let fail=true;
  const conn={query:(sql:string,params?:unknown[])=>{if(fail&&sql==='DELETE FROM identified_journal_events')throw Error('erreur simulée');return db.query(sql,params)},release:()=>{}};
  const pool={connect:async()=>conn} as unknown as Pool;
  await assert.rejects(resetTestOperations(pool),/simulée/);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM tour_closures')).rows[0].n,1);
  fail=false;await resetTestOperations(pool);
  for(const table of ['tour_closures','tour_closure_events','sync_journal_invoices','sync_journal_events','demo_sale_events'])assert.equal((await db.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
  assert.deepEqual((await db.query('SELECT opening_balance::text,credit_limit::text FROM clients WHERE id=$1',[client])).rows[0],{opening_balance:'1000000',credit_limit:'2000000'});
  assert.equal((await db.query<{mode:string}>('SELECT mode FROM tour_sync_mode')).rows[0].mode,'identified');
  for(const table of ['clients','articles','commercials','commercial_credentials','audit_log'])assert.equal((await db.query<{n:number}>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,1);
 }finally{await db.close();}
});

test('nettoyage local : files, caches et clôtures effacés, liaison commerciale conservée',async()=>{
 const db=new DatabaseSync(':memory:');
 const tables=['credit_sources_prototype_cache','credit_reference_prototype_cache','offline_credit_prototype','sales_outbox','sale_event_times','sale_revisions','sales','settlements','journal_sync_outbox','journal_sync_state','tour_journal_receipts','tour_pre_invoices','identified_local_operations','identified_reference_cache','tour_close_attempts','tour_known_server_states','reference_snapshot'];
 try {
  for(const table of tables)db.exec(`CREATE TABLE ${table}(id TEXT); INSERT INTO ${table} VALUES('fictif')`);
  db.exec("CREATE TABLE identified_device(id TEXT); INSERT INTO identified_device VALUES('commercial')");
  const tx={runAsync:async(sql:string)=>{db.prepare(sql).run()}};
  db.exec('BEGIN');await resetLocalTestOperations(tx);db.exec('ROLLBACK');
  for(const table of tables)assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n,1);
  db.exec('BEGIN');await resetLocalTestOperations(tx);db.exec('COMMIT');
  for(const table of tables)assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n,0);
  assert.equal((db.prepare('SELECT count(*) AS n FROM identified_device').get() as {n:number}).n,1);
 }finally{db.close();}
});
