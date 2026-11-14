import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {verifyCommercialSession} from './commercial-session.js';
import {lockTourClosure} from './tour-closure-store.js';
import {lockSyncMode,assertIdentifiedMode} from './tour-sync-mode.js';
import {JournalAuthenticationError,JournalConflict,TourDayClosed} from './journal-store.js';
import {lockIdentifiedOperation,assertOperationUnambiguous} from './identified-overlap.js';
import {assertCreditOperationAvailable,assertOldCreditProtocolSafe} from './credit-note-active-guards.js';

const text=z.string().trim().min(1).max(200);
const schema=z.object({operationId:z.string().uuid(),expenseId:z.string().uuid(),version:z.number().int().min(1).max(1000000),recordedAt:z.string().datetime(),description:text,amount:z.number().int().safe().positive(),reason:text}).strict();
const dayOf=(iso:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));
/** Annulation immuable ; aucune dépense ni version historique n'est supprimée. */
export async function storeExpenseCancellation(pool:Pool,input:unknown,session:{token:string;secret:string;enforceMode:boolean}):Promise<'received'|'duplicate'> {
 const change=schema.parse(input),hash=createHash('sha256').update(JSON.stringify(change)).digest('hex'),db=await pool.connect();
 try{
  await db.query('BEGIN');if(session.enforceMode)assertIdentifiedMode(await lockSyncMode(db));
  const actor=await verifyCommercialSession(db,session.secret,session.token,true);if(!actor)throw new JournalAuthenticationError('Session invalide.');
  await lockIdentifiedOperation(db,change.operationId);await assertCreditOperationAvailable(db,change.operationId);await assertOperationUnambiguous(db,change.operationId,'expense-cancellation');
  const same=await db.query('SELECT commercial_id,payload_hash FROM identified_tour_expense_cancellations WHERE operation_id=$1',[change.operationId]);
  if(same.rows.length){if(same.rows[0].commercial_id!==actor.id||same.rows[0].payload_hash!==hash)throw new JournalConflict('Identifiant d’annulation déjà utilisé.');await db.query('COMMIT');return 'duplicate';}
  if(session.enforceMode)await assertOldCreditProtocolSafe(db);
  const result=await db.query('SELECT commercial_id,journal_date::text AS day,created_at,description,amount::text AS amount FROM identified_tour_expenses WHERE operation_id=$1 FOR UPDATE',[change.expenseId]);
  const original=result.rows[0];if(!original||original.commercial_id!==actor.id)throw new JournalConflict('Dépense inconnue ou liée à un autre commercial.');
  if((await db.query('SELECT 1 FROM identified_tour_expense_cancellations WHERE expense_id=$1',[change.expenseId])).rows.length)throw new JournalConflict('Dépense déjà annulée.');
  const previous=await db.query('SELECT version,description,amount::text AS amount,recorded_at FROM identified_tour_expense_revisions WHERE expense_id=$1 ORDER BY version DESC LIMIT 1',[change.expenseId]);
  const last=previous.rows[0];if(change.version!==(last?.version??1)||change.description!==(last?.description??original.description)||String(change.amount)!==(last?.amount??original.amount)||Date.parse(change.recordedAt)<new Date(last?.recorded_at??original.created_at).getTime())throw new JournalConflict('Dépense modifiée : rapprochement nécessaire.');
  for(const day of [...new Set([original.day,dayOf(change.recordedAt)])].sort()){const closure=await lockTourClosure(db,actor.id,day);if(closure.status==='closed')throw new TourDayClosed(day,actor.id);}
  await db.query('INSERT INTO identified_tour_expense_cancellations(operation_id,expense_id,commercial_id,version,recorded_at,description,amount,reason,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[change.operationId,change.expenseId,actor.id,change.version,change.recordedAt,change.description,change.amount,change.reason,hash]);
  await db.query('COMMIT');return 'received';
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
