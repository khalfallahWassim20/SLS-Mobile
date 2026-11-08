/** Essai volontaire sur PostgreSQL : crée et supprime uniquement un schéma temporaire aléatoire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { schemaSql } from '../src/schema.js';
import { storeJournalSnapshot, JournalConflict } from '../src/journal-store.js';
import { readJournalReference } from '../src/journal-reference.js';
import {changeTourClosure, ClosureConflict, readTourClosure} from '../src/tour-closure-store.js';

dotenv.config({path:'apps/api/.env'});
test('PostgreSQL : doublons et versions concurrentes, isolés dans un schéma temporaire', async () => {
 const url=process.env.DATABASE_URL;
 if (!url) throw new Error('DATABASE_URL manquante dans apps/api/.env.');
 const schema='sls_journal_test_'+randomUUID().replaceAll('-','');
 const root=new pg.Pool({connectionString:url});
 let isolated: pg.Pool | undefined, created=false;
 try {
  await root.query(`CREATE SCHEMA "${schema}"`); created=true;
  isolated=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:5});
  await isolated.query(schemaSql); await isolated.query(schemaSql);
  const clientId=randomUUID(),id=randomUUID(), op1=randomUUID();
  await isolated.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[clientId,'Client test temporaire',1000000]);
  const invoice={id,journalDate:'2026-11-05',clientId,clientName:'Client test temporaire',sector:'Test',amount:600000,createdAt:'2026-11-05T09:00:00.000Z'};
  const first={operationId:op1,version:1,invoice,receipts:[]};
  const result=await Promise.all([storeJournalSnapshot(isolated,first,'sync'),storeJournalSnapshot(isolated,first,'sync')]);
  assert.deepEqual(result.sort(),['duplicate','received']);
  const receipt=(id:string,prePaid:number)=>({id,preInvoiceId:invoice.id,clientId,journalDate:invoice.journalDate,createdAt:'2026-11-05T10:00:00.000Z',prePaid,oldDebtPaid:0,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1000000});
  const updates=[100000,200000].map(amount=>({operationId:randomUUID(),version:2,invoice,receipts:[receipt(randomUUID(),amount)]}));
  const simultaneous=await Promise.allSettled(updates.map(e=>storeJournalSnapshot(isolated!,e,'sync')));
  assert.equal(simultaneous.filter(r=>r.status==='fulfilled').length,1);
  const failure=simultaneous.find(r=>r.status==='rejected'); assert.ok(failure && failure.status==='rejected' && failure.reason instanceof JournalConflict);
  const stored=await isolated.query('SELECT payload FROM sync_journal_events ORDER BY version DESC LIMIT 1');
  const paid=stored.rows[0].payload.receipts[0].prePaid;
  const reference=await readJournalReference(isolated);
  assert.equal(reference.clients[0].serverBalance,String(1000000+600000-paid));
  assert.equal((await isolated.query('SELECT count(*)::int AS count FROM sync_journal_events')).rows[0].count,2);
  // Deux téléphones enregistrent une facture différente pour le même client/jour.
  const competing=[1,2].map(()=>({operationId:randomUUID(),version:1,invoice:{...invoice,id:randomUUID(),journalDate:'2026-11-06'},receipts:[]}));
  const outcomes=await Promise.allSettled(competing.map(e=>storeJournalSnapshot(isolated!,e,'sync')));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  const conflict=outcomes.find(r=>r.status==='rejected'); assert.ok(conflict && conflict.status==='rejected' && conflict.reason instanceof JournalConflict);
  const dayRows=await isolated.query("SELECT count(*)::int AS count FROM sync_journal_invoices WHERE client_id=$1 AND journal_date='2026-11-06'",[clientId]);
  assert.equal(dayRows.rows[0].count,1);

  // Clôtures concurrentes : une seule transition de la version 0 peut réussir.
  const commercialId=randomUUID();
  await isolated.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial test temporaire']);
  const actor={id:commercialId,role:'commercial' as const};
  const closures=await Promise.allSettled([1,2].map(()=>changeTourClosure(isolated!,commercialId,'2026-11-07','close',actor,0)));
  assert.equal(closures.filter(r=>r.status==='fulfilled').length,1);
  const closureFailure=closures.find(r=>r.status==='rejected');
  assert.ok(closureFailure && closureFailure.status==='rejected' && closureFailure.reason instanceof ClosureConflict);
  assert.equal((await readTourClosure(isolated,commercialId,'2026-11-07')).version,1);
  assert.equal((await isolated.query('SELECT count(*)::int AS count FROM tour_closure_events')).rows[0].count,1);

 } finally {
  if (isolated) await isolated.end();
  if (created) await root.query(`DROP SCHEMA "${schema}" CASCADE`);
  await root.end();
 }
});
