import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {verifyCommercialSession} from './commercial-session.js';
import {lockTourClosure} from './tour-closure-store.js';
import {lockSyncMode,assertIdentifiedMode} from './tour-sync-mode.js';
import {JournalAuthenticationError,JournalConflict,TourDayClosed} from './journal-store.js';
import {lockIdentifiedOperation,assertOperationUnambiguous} from './identified-overlap.js';
import {assertCreditOperationAvailable,assertOldCreditProtocolSafe} from './credit-note-active-guards.js';

const text=z.string().trim().min(1).max(200),money=z.number().int().safe().positive();
const schema=z.object({operationId:z.string().uuid(),expenseId:z.string().uuid(),version:z.number().int().min(2).max(1000000),recordedAt:z.string().datetime(),previousDescription:text,previousAmount:money,description:text,amount:money}).strict();
const dayOf=(iso:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));
/** Journal immuable et reprise idempotente ; le montant d'origine reste intact. */
export async function storeExpenseRevision(pool:Pool,input:unknown,session:{token:string;secret:string;enforceMode:boolean}):Promise<'received'|'duplicate'> {
 const change=schema.parse(input),hash=createHash('sha256').update(JSON.stringify(change)).digest('hex'),db=await pool.connect();
 try{
  await db.query('BEGIN');if(session.enforceMode)assertIdentifiedMode(await lockSyncMode(db));
  const actor=await verifyCommercialSession(db,session.secret,session.token,true);if(!actor)throw new JournalAuthenticationError('Session invalide.');
  await lockIdentifiedOperation(db,change.operationId);await assertCreditOperationAvailable(db,change.operationId);await assertOperationUnambiguous(db,change.operationId,'expense-revision');
  const same=await db.query('SELECT commercial_id,payload_hash FROM identified_tour_expense_revisions WHERE operation_id=$1',[change.operationId]);
  if(same.rows.length){if(same.rows[0].commercial_id!==actor.id||same.rows[0].payload_hash!==hash)throw new JournalConflict('Identifiant de correction déjà utilisé.');await db.query('COMMIT');return 'duplicate';}
  if(session.enforceMode)await assertOldCreditProtocolSafe(db);
  // Verrouiller d'abord la dépense : deux corrections concurrentes ne peuvent
  // jamais avancer simultanément une même version.
  const result=await db.query('SELECT commercial_id,journal_date::text AS day,created_at,description,amount::text AS amount FROM identified_tour_expenses WHERE operation_id=$1 FOR UPDATE',[change.expenseId]);
  const original=result.rows[0];if(!original||original.commercial_id!==actor.id)throw new JournalConflict('Dépense inconnue ou liée à un autre commercial.');
  if((await db.query('SELECT 1 FROM identified_tour_expense_cancellations WHERE expense_id=$1',[change.expenseId])).rows.length)throw new JournalConflict('Dépense annulée : correction impossible.');
  if(Date.parse(change.recordedAt)<new Date(original.created_at).getTime())throw new JournalConflict('Date de correction incohérente.');
  const days=[...new Set([original.day,dayOf(change.recordedAt)])].sort();
  for(const day of days){const closure=await lockTourClosure(db,actor.id,day);if(closure.status==='closed')throw new TourDayClosed(day,actor.id);}
  const previous=await db.query('SELECT version,description,amount::text AS amount,recorded_at FROM identified_tour_expense_revisions WHERE expense_id=$1 ORDER BY version DESC LIMIT 1',[change.expenseId]);
  const last=previous.rows[0],version=last?.version??1,description=last?.description??original.description,amount=last?.amount??original.amount;
  if(change.version!==version+1||change.previousDescription!==description||String(change.previousAmount)!==amount||(last&&Date.parse(change.recordedAt)<new Date(last.recorded_at).getTime()))throw new JournalConflict('Dépense modifiée ou version manquante : rapprochement nécessaire.');
  if(change.description===description&&String(change.amount)===amount)throw new JournalConflict('Aucune modification.');
  await db.query('INSERT INTO identified_tour_expense_revisions(operation_id,expense_id,commercial_id,version,recorded_at,previous_description,previous_amount,description,amount,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[change.operationId,change.expenseId,actor.id,change.version,change.recordedAt,change.previousDescription,change.previousAmount,change.description,change.amount,hash]);
  await db.query('COMMIT');return 'received';
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
