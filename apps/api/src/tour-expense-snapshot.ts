import type {Pool} from 'pg';
import {z} from 'zod';
import {verifyCommercialSession} from './commercial-session.js';
import {lockSyncMode,assertIdentifiedMode} from './tour-sync-mode.js';
import {assertOldCreditProtocolSafe} from './credit-note-active-guards.js';
import {JournalAuthenticationError,JournalConflict} from './journal-store.js';
import {journalDateSchema} from './journal-protocol.js';

/** Lecture authentifiée et cohérente de toutes les versions d'une journée.
 * Pas de page partielle : au-delà de la limite on refuse la synchronisation. */
export async function readExpenseSnapshot(pool:Pool,dayInput:string,session:{token:string;secret:string;enforceMode:boolean}) {
 const day=journalDateSchema.parse(dayInput),db=await pool.connect();
 try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  if(session.enforceMode)assertIdentifiedMode(await lockSyncMode(db));
  const actor=await verifyCommercialSession(db,session.secret,session.token,true);if(!actor)throw new JournalAuthenticationError('Session invalide.');
  if(session.enforceMode)await assertOldCreditProtocolSafe(db);
  const originals=await db.query(`SELECT operation_id AS "operationId",created_at AS "createdAt",description,amount::text AS amount FROM identified_tour_expenses WHERE commercial_id=$1 AND journal_date=$2::date ORDER BY created_at,operation_id LIMIT 2001`,[actor.id,day]);
  const revisions=await db.query(`SELECT r.operation_id AS "operationId",r.expense_id AS "expenseId",r.version,r.recorded_at AS "recordedAt",r.previous_description AS "previousDescription",r.previous_amount::text AS "previousAmount",r.description,r.amount::text AS amount FROM identified_tour_expense_revisions r JOIN identified_tour_expenses e ON e.operation_id=r.expense_id WHERE e.commercial_id=$1 AND e.journal_date=$2::date ORDER BY r.expense_id,r.version LIMIT 10001`,[actor.id,day]);
  const cancellations=await db.query(`SELECT c.operation_id AS "operationId",c.expense_id AS "expenseId",c.version,c.recorded_at AS "recordedAt",c.description,c.amount::text AS amount,c.reason FROM identified_tour_expense_cancellations c JOIN identified_tour_expenses e ON e.operation_id=c.expense_id WHERE e.commercial_id=$1 AND e.journal_date=$2::date ORDER BY c.expense_id LIMIT 2001`,[actor.id,day]);
  if(originals.rows.length>2000||revisions.rows.length>10000||cancellations.rows.length>2000)throw new JournalConflict('Trop de dépenses pour une lecture complète : rapprochement nécessaire.');
  const number=(x:string)=>{const n=Number(x);if(!Number.isSafeInteger(n)||n<=0||String(n)!==x)throw new RangeError('Montant invalide.');return n;};
  const items=originals.rows.map(e=>({operationId:e.operationId,createdAt:new Date(e.createdAt).toISOString(),description:e.description,amount:number(e.amount),revisions:revisions.rows.filter(r=>r.expenseId===e.operationId).map(r=>({operationId:r.operationId,version:r.version,recordedAt:new Date(r.recordedAt).toISOString(),previousDescription:r.previousDescription,previousAmount:number(r.previousAmount),description:r.description,amount:number(r.amount)})),cancellation:(()=>{const c=cancellations.rows.find(x=>x.expenseId===e.operationId);return c?{operationId:c.operationId,version:c.version,recordedAt:new Date(c.recordedAt).toISOString(),description:c.description,amount:number(c.amount),reason:c.reason}:null;})()}));
  if(!z.string().uuid().safeParse(actor.id).success)throw new JournalConflict('Identité commerciale incohérente.');
  await db.query('COMMIT');return {version:1,commercialId:actor.id,day,expenses:items};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
