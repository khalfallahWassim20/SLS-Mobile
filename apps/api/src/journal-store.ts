/** Stockage transactionnel isolé, réservé aux tests administrateur expérimentaux. */
import type { Pool,PoolClient } from 'pg';
import {assertTourWritable} from '@sls/domain';
import {lockTourClosure} from './tour-closure-store.js';
import {verifyCommercialSession} from './commercial-session.js';
import {lockSyncMode,assertLegacyMode,assertIdentifiedMode} from './tour-sync-mode.js';
import {lockIdentifiedOperation,assertOperationUnambiguous,IdentifiedOverlap} from './identified-overlap.js';
import {assertCreditOperationAvailable,assertInvoiceNotCredited,assertOldCreditProtocolSafe} from './credit-note-active-guards.js';
import { parseJournalSnapshot, journalSnapshotHash, validateJournalTransition,type JournalSnapshot } from './journal-protocol.js';

export class JournalConflict extends Error {}
/** Uniquement après lecture verrouillée d’une journée effectivement clôturée. */
export class TourDayClosed extends JournalConflict {
 constructor(readonly day:string,readonly commercialId:string) { super('Journal clôturé : seule une réouverture par l’administrateur permet une correction.'); }
}
export class JournalAuthenticationError extends Error {}
export async function storeJournalSnapshot(pool: Pool, input: unknown, namespace: 'experimental' | 'sync' | 'identified' = 'experimental', session?:{token:string;secret:string;enforceMode?:boolean;creditAware?:boolean}, testGuard?: (db:PoolClient,event:JournalSnapshot)=>Promise<void>): Promise<'received' | 'duplicate'> {
  if(testGuard && namespace!=='identified')throw new RangeError('Garde expérimentale réservée au journal identifié.');
  const prefix = namespace === 'sync' ? 'sync_journal' : namespace === 'identified' ? 'identified_journal' : 'demo_journal';
  const event = parseJournalSnapshot(input);
  const hash = journalSnapshotHash(event);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const legacyMode=namespace==='sync' ? await lockSyncMode(db) : null;
    if(namespace==='identified' && session?.enforceMode) assertIdentifiedMode(await lockSyncMode(db));
    let commercialId:string|null=null;
    let closure:Awaited<ReturnType<typeof lockTourClosure>>|null=null;
    if(namespace==='identified') {
      if(!session) throw new JournalAuthenticationError('Session commerciale requise.');
      const actor=await verifyCommercialSession(db,session.secret,session.token,true);
      if(!actor) throw new JournalAuthenticationError('Session commerciale invalide ou expirée.');
      commercialId=actor.id;
      await lockIdentifiedOperation(db,event.operationId);
      await assertCreditOperationAvailable(db,event.operationId);
      await assertOperationUnambiguous(db,event.operationId,'journal');
      // Même verrou que la clôture, conservé jusqu'au commit de l'écriture.
      closure=await lockTourClosure(db,commercialId!,event.invoice.journalDate);
    }
    // Ordre stable : verrou sur l'opération, puis sur la facture et enfin sur le client/jour.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['journal-operation',event.operationId]);
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['journal-invoice',event.invoice.id]);
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['journal-client-day',`${event.invoice.clientId}:${event.invoice.journalDate}`]);
    const existing = await db.query(`SELECT payload_hash${namespace==='identified'?',commercial_id':''} FROM ${prefix}_events WHERE operation_id=$1`,[event.operationId]);
    if (existing.rows.length) {
      if (namespace==='identified' && existing.rows[0].commercial_id!==commercialId) throw new JournalConflict('Opération attribuée à un autre commercial.');
      if (existing.rows[0].payload_hash !== hash) throw new JournalConflict('Identifiant d’opération déjà utilisé avec d’autres données.');
      await db.query('COMMIT'); return 'duplicate';
    }
    if(legacyMode) assertLegacyMode(legacyMode);
    if(namespace==='identified' && session?.enforceMode && !session.creditAware)await assertOldCreditProtocolSafe(db);
    if(namespace==='identified') {
      if(closure!.status==='closed') throw new TourDayClosed(closure!.day,closure!.commercialId);
      assertTourWritable(closure!);
    }
    if(namespace==='identified')await assertInvoiceNotCredited(db,'preinvoice',event.invoice.id);
    // Crochet réservé à l'essai isolé. Jamais activé par les routes actuelles.
    if(testGuard)await testGuard(db,event);
    let legacyInvoiceExists=false;
    if(namespace==='identified') {
      const legacy=await db.query('SELECT id,client_id,journal_date::text AS journal_date FROM sync_journal_invoices WHERE id=$1 OR (client_id=$2 AND journal_date=$3::date)',[event.invoice.id,event.invoice.clientId,event.invoice.journalDate]);
      if(legacy.rows.some(r=>r.id!==event.invoice.id || r.client_id!==event.invoice.clientId || r.journal_date!==event.invoice.journalDate)) throw new IdentifiedOverlap('Une autre facture existe dans l’ancien journal : rapprochement nécessaire.');
      legacyInvoiceExists=legacy.rows.length>0;
    }
    const invoice = await db.query(`SELECT id,client_id,journal_date::text AS journal_date${namespace==='identified'?',commercial_id':''} FROM ${prefix}_invoices WHERE id=$1 OR (client_id=$2 AND journal_date=$3::date)`,[event.invoice.id,event.invoice.clientId,event.invoice.journalDate]);
    if (invoice.rows.some(r => r.id !== event.invoice.id || r.client_id !== event.invoice.clientId || r.journal_date !== event.invoice.journalDate)) throw new JournalConflict('Une autre facture existe déjà pour ce client et cette date.');
    if(namespace==='identified' && invoice.rows.some(r=>r.commercial_id!==null && r.commercial_id!==commercialId)) throw new JournalConflict('Facture attribuée à un autre commercial.');
    const last = await db.query(`SELECT payload FROM ${prefix}_events WHERE invoice_id=$1 ORDER BY version DESC LIMIT 1`,[event.invoice.id]);
    const old=namespace==='identified' ? await db.query('SELECT payload FROM sync_journal_events WHERE invoice_id=$1 ORDER BY version DESC LIMIT 1',[event.invoice.id]) : null;
    if(legacyInvoiceExists && !old?.rows.length) throw new IdentifiedOverlap('Historique de facture manquant : rapprochement nécessaire.');
    const previous=last.rows.length ? parseJournalSnapshot(last.rows[0].payload) : old?.rows.length ? parseJournalSnapshot(old.rows[0].payload) : null;
    if(namespace==='identified' && old?.rows.length && invoice.rows.length && invoice.rows[0].commercial_id!==null) throw new IdentifiedOverlap('Attribution historique incohérente.');
    if(namespace==='identified' && !old?.rows.length && invoice.rows.length && invoice.rows[0].commercial_id===null) throw new IdentifiedOverlap('Historique initial manquant.');
    if(namespace==='identified' && !previous && event.receipts.length) throw new JournalConflict('Une nouvelle facture identifiée doit débuter sans paiements historiques.');
    try { validateJournalTransition(previous,event); }
    catch (error) { throw new JournalConflict(error instanceof Error ? error.message : 'Version du journal incohérente.'); }
    if (!invoice.rows.length) {
      const client = await db.query('SELECT id FROM clients WHERE id=$1 AND deleted_at IS NULL',[event.invoice.clientId]);
      if (!client.rows.length) throw new JournalConflict('Client introuvable sur le serveur.');
      if(namespace==='identified') await db.query(`INSERT INTO ${prefix}_invoices(id,client_id,journal_date,commercial_id) VALUES($1,$2,$3::date,$4)`,[event.invoice.id,event.invoice.clientId,event.invoice.journalDate,old?.rows.length?null:commercialId]);
      else await db.query(`INSERT INTO ${prefix}_invoices(id,client_id,journal_date) VALUES($1,$2,$3::date)`,[event.invoice.id,event.invoice.clientId,event.invoice.journalDate]);
    }
    for (const receipt of [...event.receipts].sort((a,b) => a.id.localeCompare(b.id))) {
      if(namespace==='identified') {
        const oldOwner=await db.query('SELECT invoice_id FROM sync_journal_receipt_ids WHERE id=$1',[receipt.id]);
        if(oldOwner.rows.length) {
          if(oldOwner.rows[0].invoice_id!==event.invoice.id || !old?.rows.length || !parseJournalSnapshot(old.rows[0].payload).receipts.some(r=>r.id===receipt.id)) throw new IdentifiedOverlap('Règlement de journal déjà présent dans l’ancien espace.');
          continue;
        }
      }
      await db.query(`INSERT INTO ${prefix}_receipt_ids(id,invoice_id) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`,[receipt.id,event.invoice.id]);
      const owner = await db.query(`SELECT invoice_id FROM ${prefix}_receipt_ids WHERE id=$1`,[receipt.id]);
      if (owner.rows[0]?.invoice_id !== event.invoice.id) throw new JournalConflict('Identifiant de règlement déjà utilisé pour une autre facture.');
    }
    if(namespace==='identified') await db.query(`INSERT INTO ${prefix}_events(operation_id,invoice_id,commercial_id,version,payload,payload_hash) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[event.operationId,event.invoice.id,commercialId,event.version,JSON.stringify(event),hash]);
    else await db.query(`INSERT INTO ${prefix}_events(operation_id,invoice_id,version,payload,payload_hash) VALUES($1,$2,$3,$4::jsonb,$5)`,[event.operationId,event.invoice.id,event.version,JSON.stringify(event),hash]);
    await db.query('COMMIT'); return 'received';
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
