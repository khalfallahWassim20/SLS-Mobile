import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {assertNoLocalCreditNote} from '../../../apps/mobile/credit-note-local-guard.js';

test('table locale : mise à niveau répétable et protection des factures annulées',async()=>{
 const db=new DatabaseSync(':memory:');try {
  db.exec("CREATE TABLE sales(id INTEGER PRIMARY KEY,payload TEXT); INSERT INTO sales VALUES(1,'vente existante')");
  db.exec(offlineCreditPrototypeSchema);db.exec(offlineCreditPrototypeSchema);
  assert.equal(db.prepare('SELECT payload FROM sales WHERE id=1').get()?.payload,'vente existante');
  const tx={getFirstAsync:async<T>(sql:string,...params:(string|number|null)[])=>db.prepare(sql).get(...params) as T||null};
  const id=randomUUID();await assertNoLocalCreditNote(tx,'sale',id);await assertNoLocalCreditNote(tx,'preinvoice',id);
  db.prepare('INSERT INTO offline_credit_prototype VALUES(?,?,?,?,?,?,1)').run(randomUUID(),id,'sale',randomUUID(),'https://example.test','{}');
  await assert.rejects(assertNoLocalCreditNote(tx,'sale',id),/annulée/);
  await assertNoLocalCreditNote(tx,'preinvoice',id);
  db.prepare('UPDATE offline_credit_prototype SET pending=0').run();
  await assert.rejects(assertNoLocalCreditNote(tx,'sale',id),/annulée/);
 }finally{db.close();}
});
