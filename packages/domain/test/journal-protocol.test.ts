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
