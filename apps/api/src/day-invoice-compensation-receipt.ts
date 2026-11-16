/** Reçu expérimental : une réponse HTTP ne suffit pas pour effacer une file.
 * Le reçu relit et vérifie les preuves dans un instantané unique. Il n'est
 * accessible qu'au commercial ayant enregistré la révision et n'atteste pas
 * que l'argent a été remis physiquement au client. */
import type {Pool} from 'pg';
import {z} from 'zod';
import {verifyCommercialSession} from './commercial-session.js';
import {JournalAuthenticationError,JournalConflict} from './journal-store.js';
import {assertIdentifiedMode,lockSyncMode} from './tour-sync-mode.js';
import {assertOldCreditProtocolSafe} from './credit-note-active-guards.js';
import {readDayInvoiceCompensationProjectionInTransaction,readCompensatedDayInvoiceSnapshotInTransaction} from './day-invoice-reference.js';
import {saleEventSchema} from './identified-operations.js';
import {compensationSchema} from './day-invoice-compensation.js';

/** Lecture test-only du client concerné, sans exposer la référence complète.
 * Session, propriétaire, sources et solde partagent le même instantané. */
export async function readAuthenticatedCompensatedInvoice(pool:Pool,operationId:string,session:{secret:string;token:string}){
 z.string().uuid().parse(operationId);
 const db=await pool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));
  const actor=await verifyCommercialSession(db,session.secret,session.token,true);
  if(!actor)throw new JournalAuthenticationError('Session invalide.');
  const owner=await db.query('SELECT commercial_id FROM identified_day_invoice_compensations WHERE operation_id=$1',[operationId]);
  if(owner.rows.length!==1||owner.rows[0].commercial_id!==actor.id)throw new JournalConflict('Facture indisponible pour ce commercial.');
  await assertOldCreditProtocolSafe(db);
  const snapshot=await readCompensatedDayInvoiceSnapshotInTransaction(db,operationId);
  if(snapshot.compensation.commercialId!==actor.id)throw new JournalConflict('Facture incohérente.');
  const result={version:1 as const,compensation:snapshot.compensation,invoice:snapshot.invoice};
  await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

export async function readCompensationReceipt(pool:Pool,operationId:string,session:{secret:string;token:string}){
 z.string().uuid().parse(operationId);
 const db=await pool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  assertIdentifiedMode(await lockSyncMode(db));
  const actor=await verifyCommercialSession(db,session.secret,session.token,true);
  if(!actor)throw new JournalAuthenticationError('Session invalide.');
  // Vérifier le propriétaire avant de lire la projection ou le solde du client.
  const owner=await db.query('SELECT commercial_id FROM identified_day_invoice_compensations WHERE operation_id=$1',[operationId]);
  if(owner.rows.length!==1||owner.rows[0].commercial_id!==actor.id)throw new JournalConflict('Reçu indisponible pour ce commercial.');
  await assertOldCreditProtocolSafe(db);
  const projection=await readDayInvoiceCompensationProjectionInTransaction(db,operationId);
  const rows=await db.query(`SELECT s.payload AS event,c.payload AS compensation FROM identified_day_invoice_compensations c JOIN identified_sale_events s ON s.operation_id=c.operation_id WHERE c.operation_id=$1`,[operationId]);
  if(rows.rows.length!==1||projection.commercialId!==actor.id)throw new JournalConflict('Reçu incohérent.');
  const receipt={event:saleEventSchema.parse(rows.rows[0].event),compensation:compensationSchema.parse(rows.rows[0].compensation),projection};
  await db.query('COMMIT');return receipt;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
