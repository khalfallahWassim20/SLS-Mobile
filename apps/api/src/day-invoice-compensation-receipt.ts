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
import {readIndependentCompensationProjectionsInTransaction,readCompensatedDayInvoiceSnapshotInTransaction} from './day-invoice-reference.js';
import {saleEventSchema} from './identified-operations.js';
import {readCompensatedJournalDayInTransaction} from './identified-journal-day.js';
import {compensationSchema} from './day-invoice-compensation.js';
import {readFrozenCompensationReceipt} from './day-invoice-frozen-receipt.js';

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
  const p=snapshot.compensation;
  const day=await readCompensatedJournalDayInTransaction(db,actor.id,p.eventDay,operationId);
  const rows=day.rows.filter(r=>r.clientId===p.clientId);
  if(!day.compensationEvents.some(e=>e.operationId===operationId)||rows.length!==1||rows[0].compensationRefund!==p.refund||rows[0].compensationCredit!==p.credit)throw new JournalConflict('Journal de compensation incohérent.');
  // Impact théorique uniquement : le choix n'atteste aucun versement physique
  // et ne permet pas de l'attribuer à un mode de paiement.
  const journal={commercialId:actor.id,day:p.eventDay,clientId:p.clientId,gross:day.totalCollected,refund:day.compensationRefundTotal,credit:day.compensationCreditTotal,ownRefund:p.refund,ownCredit:p.credit,theoreticalNet:day.collectedAfterCompensationRefund,clientGross:rows[0].totalCollected,clientTheoreticalNet:rows[0].afterCompensationRefund};
  const result={version:3 as const,compensation:p,invoice:snapshot.invoice,journal};
  await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

/** Journal du commercial après choix, lecture fictive uniquement. Aucun solde
 * client, aucun mode de remboursement ni preuve de versement n'est déduit. */
export async function readAuthenticatedCompensatedJournal(pool:Pool,operationId:string,session:{secret:string;token:string}){
 z.string().uuid().parse(operationId);const db=await pool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));
  const actor=await verifyCommercialSession(db,session.secret,session.token,true);if(!actor)throw new JournalAuthenticationError('Session invalide.');
  const owner=await db.query('SELECT commercial_id FROM identified_day_invoice_compensations WHERE operation_id=$1',[operationId]);
  if(owner.rows.length!==1||owner.rows[0].commercial_id!==actor.id)throw new JournalConflict('Journal indisponible pour ce commercial.');
  await assertOldCreditProtocolSafe(db);
  const snapshot=await readCompensatedDayInvoiceSnapshotInTransaction(db,operationId),p=snapshot.compensation;
  if(p.commercialId!==actor.id)throw new JournalConflict('Compensation incohérente.');
  const day=await readCompensatedJournalDayInTransaction(db,actor.id,p.eventDay,operationId);
  if(!day.compensationEvents.some(e=>e.operationId===operationId&&e.clientId===p.clientId))throw new JournalConflict('Compensation absente du journal.');
  const result={version:1 as const,operationId,commercialId:actor.id,day:p.eventDay,clientId:p.clientId,
   totalBilled:day.totalBilled,totalCollected:day.totalCollected,refund:day.compensationRefundTotal,credit:day.compensationCreditTotal,theoreticalNet:day.collectedAfterCompensationRefund,
   rows:day.rows.map(r=>({clientId:r.clientId,clientName:r.clientName,sector:r.sector,preInvoiceTotal:r.preInvoiceTotal,salesTotal:r.tourTotal,totalClient:r.totalClient,dayInvoicePaid:r.dayInvoicePaid,oldDebtPaid:r.oldDebtPaid,totalCollected:r.totalCollected,refund:r.compensationRefund,credit:r.compensationCredit,theoreticalNet:r.afterCompensationRefund}))};
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
  // Les nouveaux reçus représentent l'instant de l'écriture et ne doivent
  // pas être recalculés à partir d'un solde qui a pu évoluer depuis.
  const frozen=await readFrozenCompensationReceipt(db,operationId,actor.id);
  if(frozen){await db.query('COMMIT');return frozen;}
  // Compatibilité conservatrice avec les compensations antérieures à la migration.
  const projections=await readIndependentCompensationProjectionsInTransaction(db),projection=projections.find(p=>p.operationId===operationId);
  if(!projection)throw new JournalConflict('Reçu incohérent.');
  const rows=await db.query(`SELECT s.payload AS event,c.payload AS compensation FROM identified_day_invoice_compensations c JOIN identified_sale_events s ON s.operation_id=c.operation_id WHERE c.operation_id=$1`,[operationId]);
  if(rows.rows.length!==1||projection.commercialId!==actor.id)throw new JournalConflict('Reçu incohérent.');
  const receipt={event:saleEventSchema.parse(rows.rows[0].event),compensation:compensationSchema.parse(rows.rows[0].compensation),projection};
  await db.query('COMMIT');return receipt;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
