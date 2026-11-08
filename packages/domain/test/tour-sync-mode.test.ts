import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {assertLegacyMode,lockSyncMode,readSyncMode,LegacySyncDisabled} from '../../../apps/api/src/tour-sync-mode.js';
import {storeJournalSnapshot} from '../../../apps/api/src/journal-store.js';
import {readJournalReference} from '../../../apps/api/src/journal-reference.js';

test('mode préparatoire : bloque les nouvelles écritures partagées mais reconnaît les doublons reçus',async()=>{
 const db=new PGlite();
 try {
  await db.exec(schemaSql);await db.exec(schemaSql);
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>conn,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  assert.equal(await readSyncMode(pool),'legacy');assert.doesNotThrow(()=>assertLegacyMode('legacy'));
  const clientId=randomUUID();await db.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Fictif']);
  const invoice={id:randomUUID(),clientId,clientName:'Fictif',journalDate:'2026-11-11',sector:'',amount:600000,createdAt:'2026-11-11T08:00:00.000Z'};
  const initial={operationId:randomUUID(),version:1,invoice,receipts:[]};
  assert.equal(await storeJournalSnapshot(pool,initial,'sync'),'received');
  assert.equal((await readJournalReference(pool,false,true)).version,3);
  // Bascule simulée en base de test uniquement : aucun endpoint ne permet de le faire.
  await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  assert.equal(await readSyncMode(pool),'identified');assert.throws(()=>assertLegacyMode('identified'),LegacySyncDisabled);
  assert.equal(await storeJournalSnapshot(pool,initial,'sync'),'duplicate');
  const other={...initial,operationId:randomUUID(),invoice:{...invoice,id:randomUUID(),journalDate:'2026-11-12'}};
  await assert.rejects(storeJournalSnapshot(pool,other,'sync'),LegacySyncDisabled);
  await assert.rejects(readJournalReference(pool,false,true),LegacySyncDisabled);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM sync_journal_events')).rows[0].n,1);
  await db.exec(schemaSql);assert.equal(await readSyncMode(pool),'identified');
  await db.query('DELETE FROM tour_sync_mode WHERE id=1');
  await assert.rejects(lockSyncMode(conn as any),/indisponible/);
 } finally {await db.close();}
});
