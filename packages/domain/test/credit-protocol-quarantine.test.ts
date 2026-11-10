import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {quarantineOnUpgrade} from '../../../apps/mobile/credit-protocol-quarantine.js';
import {assertLegacyMobileCreditSafe} from '../../../apps/mobile/credit-note-write-guard-prototype.js';
import {readLegacyRows} from '../../../apps/mobile/legacy-read-guard.js';
import {resetLocalTestOperations} from '../../../apps/mobile/reset-test-operations.js';

test('refus serveur explicite : blocage persistant sans effacer données ou file',async()=>{
 const db=new DatabaseSync(':memory:'),id={commercialId:'a1000000-0000-4000-8000-000000000001',serverOrigin:'https://sls.example.test'};
 try{
  db.exec(`${identifiedDeviceSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}`);
  const others=['credit_sources_prototype_cache','sales_outbox','sale_event_times','sale_revisions','sales','settlements','journal_sync_outbox','journal_sync_state','tour_journal_receipts','tour_pre_invoices','tour_close_attempts','tour_known_server_states','reference_snapshot'];
  for(const table of others)db.exec(`CREATE TABLE ${table}(id TEXT)`);
  db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(id.commercialId,id.serverOrigin);
  db.exec("INSERT INTO sales VALUES('facture'); INSERT INTO sales_outbox VALUES('operation')");
  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{db.prepare(sql).run(...args)}};
  const marker={code:'CREDIT_PROTOCOL_UPGRADE_REQUIRED'};
  assert.equal(await quarantineOnUpgrade(tx,id,401,marker),false);
  assert.equal(await quarantineOnUpgrade(tx,id,409,{code:'TOUR_DAY_CLOSED'}),false);
  assert.equal((await readLegacyRows(tx,'SELECT id FROM sales')).length,1);
  await assert.rejects(quarantineOnUpgrade(tx,{...id,serverOrigin:'https://other.example.test'},409,marker),/différent/);
  db.exec('BEGIN');assert.equal(await quarantineOnUpgrade(tx,id,409,marker),true);db.exec('ROLLBACK');
  assert.equal((await readLegacyRows(tx,'SELECT id FROM sales')).length,1);
  db.exec('BEGIN');assert.equal(await quarantineOnUpgrade(tx,id,409,marker),true);db.exec('COMMIT');
  assert.equal(await quarantineOnUpgrade(tx,id,409,marker),true);
  await assert.rejects(assertLegacyMobileCreditSafe(tx,id),/rapprochement v5/);
  await assert.rejects(readLegacyRows(tx,'SELECT id FROM sales'),/rapprochement v5/);
  assert.equal(db.prepare('SELECT count(*) n FROM sales').get()?.n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,1);
  // Seul le nettoyage fictif explicite retire aussi le blocage ; sa transaction
  // est réversible et l'identité reste liée.
  db.exec('BEGIN');await resetLocalTestOperations(tx);db.exec('ROLLBACK');
  await assert.rejects(readLegacyRows(tx,'SELECT id FROM sales'),/rapprochement v5/);
  db.exec('BEGIN');await resetLocalTestOperations(tx);db.exec('COMMIT');
  assert.deepEqual(await readLegacyRows(tx,'SELECT id FROM sales'),[]);
  assert.equal(db.prepare('SELECT count(*) n FROM identified_device').get()?.n,1);
 }finally{db.close();}
});
