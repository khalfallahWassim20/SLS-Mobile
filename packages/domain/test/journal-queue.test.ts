import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { bootstrapJournalQueue, journalQueueSchema, queueJournalSnapshot, type QueueTransaction } from '../../../apps/mobile/journal-queue.js';
import { parseJournalSnapshot, validateJournalTransition } from '../../../apps/api/src/journal-protocol.js';

const uuid = (n:number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const invoice={id:uuid(1),journalDate:'2026-11-04',clientId:uuid(2),clientName:'Client démo',sector:'Gabès',amount:600000,createdAt:'2026-11-04T08:00:00.000Z'};
const receipt={id:uuid(3),preInvoiceId:invoice.id,clientId:invoice.clientId,journalDate:invoice.journalDate,createdAt:'2026-11-04T09:00:00.000Z',prePaid:200000,oldDebtPaid:0,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:0};
function createDb() {
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE tour_pre_invoices(id TEXT PRIMARY KEY,journal_date TEXT NOT NULL,client_id TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(journal_date,client_id));
 CREATE TABLE tour_journal_receipts(id TEXT PRIMARY KEY,pre_invoice_id TEXT NOT NULL,client_id TEXT NOT NULL,journal_date TEXT NOT NULL,payload TEXT NOT NULL); ${journalQueueSchema}`);
 const tx = {
  getAllAsync: async <T>(sql:string,...params:(string|number|null)[]) => db.prepare(sql).all(...params) as T[],
  getFirstAsync: async <T>(sql:string,...params:(string|number|null)[]) => (db.prepare(sql).get(...params) ?? null) as T|null,
  runAsync: async (sql:string,...params:(string|number|null)[]) => db.prepare(sql).run(...params)
 } satisfies QueueTransaction;
 const insertInvoice=()=>db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(invoice.id,invoice.journalDate,invoice.clientId,JSON.stringify(invoice));
 const insertReceipt=()=>db.prepare('INSERT INTO tour_journal_receipts VALUES(?,?,?,?,?)').run(receipt.id,invoice.id,invoice.clientId,invoice.journalDate,JSON.stringify(receipt));
 return {db,tx,insertInvoice,insertReceipt};
}
test('file SQLite : reprise des anciens journaux, versions immuables et ordre', async () => {
 const {db,tx,insertInvoice,insertReceipt}=createDb();
 try {
  insertInvoice(); insertReceipt();
  await bootstrapJournalQueue(tx,()=>uuid(10));
  await bootstrapJournalQueue(tx,()=>uuid(11));
  const original = db.prepare('SELECT payload FROM journal_sync_outbox').get() as {payload:string};
  const first = parseJournalSnapshot(JSON.parse(original.payload));
  assert.equal(first.version,1); assert.equal(first.receipts.length,1);
  const secondReceipt={...receipt,id:uuid(4),prePaid:100000};
  db.prepare('INSERT INTO tour_journal_receipts VALUES(?,?,?,?,?)').run(secondReceipt.id,invoice.id,invoice.clientId,invoice.journalDate,JSON.stringify(secondReceipt));
  await queueJournalSnapshot(tx,invoice.id,()=>uuid(12));
  const rows=db.prepare('SELECT payload FROM journal_sync_outbox ORDER BY sequence').all() as {payload:string}[];
  assert.equal(rows.length,2); const second=parseJournalSnapshot(JSON.parse(rows[1].payload));
  validateJournalTransition(first,second); assert.equal(second.receipts.length,2);
  assert.equal(rows[0].payload,original.payload);
 } finally {db.close();}
});
test('file SQLite : échec de mise en file annule le règlement dans la même transaction', async () => {
 const {db,tx,insertInvoice,insertReceipt}=createDb();
 try {
  insertInvoice(); await queueJournalSnapshot(tx,invoice.id,()=>uuid(10));
  db.exec('BEGIN'); insertReceipt();
  await assert.rejects(queueJournalSnapshot(tx,invoice.id,()=>uuid(10))); // UUID de l’opération déjà utilisé
  db.exec('ROLLBACK');
  assert.equal((db.prepare('SELECT count(*) AS n FROM tour_journal_receipts').get() as {n:number}).n,0);
  assert.equal((db.prepare('SELECT count(*) AS n FROM journal_sync_outbox').get() as {n:number}).n,1);
  assert.equal((db.prepare('SELECT version FROM journal_sync_state').get() as {version:number}).version,1);
 } finally {db.close();}
});

test('nouvelle facture et paiement : deux versions, un retour arrière est refusé', async () => {
 const {db,tx,insertInvoice,insertReceipt}=createDb();
 try {
  db.exec('BEGIN'); insertInvoice(); await queueJournalSnapshot(tx,invoice.id,()=>uuid(10)); db.exec('COMMIT');
  db.exec('BEGIN'); insertReceipt(); await queueJournalSnapshot(tx,invoice.id,()=>uuid(11)); db.exec('COMMIT');
  const rows=db.prepare('SELECT payload FROM journal_sync_outbox ORDER BY sequence').all() as {payload:string}[];
  const a=parseJournalSnapshot(JSON.parse(rows[0].payload)), b=parseJournalSnapshot(JSON.parse(rows[1].payload));
  assert.equal(a.receipts.length,0); validateJournalTransition(a,b);
  db.exec('BEGIN'); db.prepare('DELETE FROM tour_journal_receipts').run();
  await assert.rejects(queueJournalSnapshot(tx,invoice.id,()=>uuid(12)),/incohérent/); db.exec('ROLLBACK');
  assert.equal((db.prepare('SELECT count(*) AS n FROM tour_journal_receipts').get() as {n:number}).n,1);
 } finally { db.close(); }
});
