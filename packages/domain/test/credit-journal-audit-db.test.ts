import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial} from '../../../apps/api/src/commercials.js';
import {readPrototypeCreditJournal} from '../../../apps/api/src/credit-note-journal-prototype.js';
import {auditCreditJournal,type CreditJournalView} from '../src/credit-note-audit.ts';
test('journal avec avoirs : le vrai journal serveur d’un jour sans opération est cohérent',async()=>{
 const db=new PGlite();
 try{
  await db.exec(schemaSql);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>conn,query:conn.query} as unknown as Pool;
  const c=await saveCommercial(pool,'admin',{name:'Pilote',active:true});
  const journal=await readPrototypeCreditJournal(pool,c.id,'2026-01-01');
  assert.equal(journal.creditEvents.length,0);
  assert.deepEqual(auditCreditJournal(journal as unknown as CreditJournalView),[]);
 }finally{await db.close();}
});
