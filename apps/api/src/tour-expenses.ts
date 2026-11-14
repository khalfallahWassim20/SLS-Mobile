import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {verifyCommercialSession} from './commercial-session.js';
import {lockTourClosure} from './tour-closure-store.js';
import {lockSyncMode,assertIdentifiedMode} from './tour-sync-mode.js';
import {JournalAuthenticationError,JournalConflict,TourDayClosed} from './journal-store.js';
import {lockIdentifiedOperation,assertOperationUnambiguous} from './identified-overlap.js';
import {assertCreditOperationAvailable,assertOldCreditProtocolSafe} from './credit-note-active-guards.js';

const schema=z.object({operationId:z.string().uuid(),createdAt:z.string().datetime(),description:z.string().trim().min(1).max(200),amount:z.number().int().safe().positive()}).strict();
const tunisDay=(iso:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));
/** Append-only : une dépense reçue ne peut être modifiée ni effacée par une reprise. */
export async function storeTourExpense(pool:Pool,input:unknown,session:{token:string;secret:string;enforceMode:boolean}):Promise<'received'|'duplicate'>{
 const expense=schema.parse(input),day=tunisDay(expense.createdAt),hash=createHash('sha256').update(JSON.stringify(expense)).digest('hex'),db=await pool.connect();
 try{
  await db.query('BEGIN');if(session.enforceMode)assertIdentifiedMode(await lockSyncMode(db));
  const actor=await verifyCommercialSession(db,session.secret,session.token,true);if(!actor)throw new JournalAuthenticationError('Session invalide.');
  await lockIdentifiedOperation(db,expense.operationId);await assertCreditOperationAvailable(db,expense.operationId);await assertOperationUnambiguous(db,expense.operationId,'expense');
  const existing=await db.query('SELECT commercial_id,payload_hash FROM identified_tour_expenses WHERE operation_id=$1',[expense.operationId]);
  if(existing.rows.length){if(existing.rows[0].commercial_id!==actor.id||existing.rows[0].payload_hash!==hash)throw new JournalConflict('Identifiant de dépense déjà utilisé.');await db.query('COMMIT');return 'duplicate';}
  if(session.enforceMode)await assertOldCreditProtocolSafe(db);
  const closure=await lockTourClosure(db,actor.id,day);if(closure.status==='closed')throw new TourDayClosed(day,actor.id);
  await db.query('INSERT INTO identified_tour_expenses(operation_id,commercial_id,journal_date,created_at,description,amount,payload_hash) VALUES($1,$2,$3::date,$4,$5,$6,$7)',[expense.operationId,actor.id,day,expense.createdAt,expense.description,expense.amount,hash]);
  await db.query('COMMIT');return 'received';
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
