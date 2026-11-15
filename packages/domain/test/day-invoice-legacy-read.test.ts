import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dayInvoiceQueueSchema} from '../../../apps/mobile/day-invoice-queue.js';
import {dayInvoiceReferenceCacheSchema} from '../../../apps/mobile/day-invoice-reference-cache.js';
import {assertLegacyMobileDayInvoiceSafe} from '../../../apps/mobile/day-invoice-legacy-guard.js';
test('anciens écrans refusent les paiements ou la référence v6 sans les modifier',async()=>{
 const db=new DatabaseSync(':memory:');try{
  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null};
  await assertLegacyMobileDayInvoiceSafe(tx);db.exec(dayInvoiceQueueSchema+dayInvoiceReferenceCacheSchema);await assertLegacyMobileDayInvoiceSafe(tx);
  db.prepare('INSERT INTO day_invoice_reference_cache VALUES(1,?,?,?)').run('commercial','origine','{}');
  await assert.rejects(assertLegacyMobileDayInvoiceSafe(tx),/Référence facture du jour/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM day_invoice_reference_cache').get()?.n,1);
  db.exec('DELETE FROM day_invoice_reference_cache');
  db.prepare('INSERT INTO day_invoice_payments VALUES(?,?,?,?,?,?)').run('operation','client','2026-01-01','{}','commercial','origine');
  await assert.rejects(assertLegacyMobileDayInvoiceSafe(tx),/Facture du jour présente/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM day_invoice_payments').get()?.n,1);
 }finally{db.close();}
});
