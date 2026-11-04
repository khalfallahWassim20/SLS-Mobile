/** Stockage transactionnel de démonstration. Non connecté à une route HTTP. */
import type { Pool } from 'pg';
import { parseJournalSnapshot, journalSnapshotHash, validateJournalTransition } from './journal-protocol.js';

export class JournalConflict extends Error {}
export async function storeJournalSnapshot(pool: Pool, input: unknown): Promise<'received' | 'duplicate'> {
  const event = parseJournalSnapshot(input);
  const hash = journalSnapshotHash(event);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Ordre stable : verrou sur l'opération, puis sur la facture et enfin sur le client/jour.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['journal-operation',event.operationId]);
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['journal-invoice',event.invoice.id]);
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['journal-client-day',`${event.invoice.clientId}:${event.invoice.journalDate}`]);
    const existing = await db.query('SELECT payload_hash FROM demo_journal_events WHERE operation_id=$1',[event.operationId]);
    if (existing.rows.length) {
      if (existing.rows[0].payload_hash !== hash) throw new JournalConflict('Identifiant d’opération déjà utilisé avec d’autres données.');
      await db.query('COMMIT'); return 'duplicate';
    }
    const invoice = await db.query('SELECT id,client_id,journal_date::text AS journal_date FROM demo_journal_invoices WHERE id=$1 OR (client_id=$2 AND journal_date=$3::date)',[event.invoice.id,event.invoice.clientId,event.invoice.journalDate]);
    if (invoice.rows.some(r => r.id !== event.invoice.id || r.client_id !== event.invoice.clientId || r.journal_date !== event.invoice.journalDate)) throw new JournalConflict('Une autre facture existe déjà pour ce client et cette date.');
    const last = await db.query('SELECT payload FROM demo_journal_events WHERE invoice_id=$1 ORDER BY version DESC LIMIT 1',[event.invoice.id]);
    try { validateJournalTransition(last.rows.length ? parseJournalSnapshot(last.rows[0].payload) : null,event); }
    catch (error) { throw new JournalConflict(error instanceof Error ? error.message : 'Version du journal incohérente.'); }
    if (!invoice.rows.length) {
      const client = await db.query('SELECT id FROM clients WHERE id=$1 AND deleted_at IS NULL',[event.invoice.clientId]);
      if (!client.rows.length) throw new JournalConflict('Client introuvable sur le serveur.');
      await db.query('INSERT INTO demo_journal_invoices(id,client_id,journal_date) VALUES($1,$2,$3::date)',[event.invoice.id,event.invoice.clientId,event.invoice.journalDate]);
    }
    for (const receipt of event.receipts) {
      await db.query('INSERT INTO demo_journal_receipt_ids(id,invoice_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[receipt.id,event.invoice.id]);
      const owner = await db.query('SELECT invoice_id FROM demo_journal_receipt_ids WHERE id=$1',[receipt.id]);
      if (owner.rows[0]?.invoice_id !== event.invoice.id) throw new JournalConflict('Identifiant de règlement déjà utilisé pour une autre facture.');
    }
    await db.query('INSERT INTO demo_journal_events(operation_id,invoice_id,version,payload,payload_hash) VALUES($1,$2,$3,$4::jsonb,$5)',[event.operationId,event.invoice.id,event.version,JSON.stringify(event),hash]);
    await db.query('COMMIT'); return 'received';
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
