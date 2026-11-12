/** Attribution explicite d'une sortie d'avoir admin. Il ne s'agit pas d'une
 * preuve que l'argent a été réellement versé. Affectation définitive v5 test. */
import {z} from 'zod';
import type {Pool} from 'pg';
import {assertIdentifiedMode,lockSyncModeExclusive} from './tour-sync-mode.js';
import {readPrototypeCreditHistoryInTransaction} from './credit-note-history-prototype.js';
import {lockTourClosure} from './tour-closure-store.js';
import {JournalConflict} from './journal-store.js';
const input=z.object({requestId:z.string().uuid(),noteOperationId:z.string().uuid(),refund:z.number().int().safe().positive(),commercialId:z.string().uuid().nullable()}).strict();
export async function assignAdminCreditRefund(pool:Pool,raw:unknown,actorId:string){
 const command=input.parse(raw);if(typeof actorId!=='string'||!actorId.trim()||actorId.length>200)throw new RangeError('Administrateur invalide.');
 const db=await pool.connect();try{
  await db.query('BEGIN');assertIdentifiedMode(await lockSyncModeExclusive(db));
  // Même identifiant = même décision ; les affectations concurrentes et les
  // clôtures sont sérialisées par le verrou global de mode.
  const old=await db.query(`SELECT note_operation_id AS "noteOperationId",request_id AS "requestId",commercial_id AS "commercialId",refund::text,actor_id AS "actorId",assigned_at AS "assignedAt" FROM credit_refund_assignment_prototype WHERE request_id=$1 OR note_operation_id=$2`,[command.requestId,command.noteOperationId]);
  if(old.rows.length){const r=old.rows[0];if(old.rows.length!==1||r.requestId!==command.requestId||r.noteOperationId!==command.noteOperationId||r.commercialId!==command.commercialId||r.refund!==String(command.refund)||r.actorId!==actorId)throw new JournalConflict('Affectation déjà enregistrée ou identifiant de demande déjà utilisé.');await db.query('COMMIT');return {status:'duplicate' as const,...command,assignedAt:new Date(r.assignedAt).toISOString()};}
  const history=await readPrototypeCreditHistoryInTransaction(db),note=history.find(h=>h.operationId===command.noteOperationId);
  if(!note||note.actor.role!=='admin'||note.refund<=0||note.refund!==command.refund)throw new JournalConflict('Avoir administrateur introuvable ou montant modifié : actualisez le journal.');
  if(command.commercialId){
   const found=await db.query('SELECT id FROM commercials WHERE id=$1 AND active=true AND deleted_at IS NULL',[command.commercialId]);if(!found.rows.length)throw new JournalConflict('Commercial actif introuvable.');
   const closure=await lockTourClosure(db,command.commercialId,note.recordedDay);if(closure.status==='closed')throw new JournalConflict('La journée de ce commercial est clôturée : demandez sa réouverture.');
  }
  const result=await db.query(`INSERT INTO credit_refund_assignment_prototype(note_operation_id,request_id,commercial_id,refund,actor_id) VALUES($1,$2,$3,$4,$5) RETURNING assigned_at AS "assignedAt"`,[command.noteOperationId,command.requestId,command.commercialId,command.refund,actorId]);
  await db.query('COMMIT');return {status:'received' as const,...command,assignedAt:new Date(result.rows[0].assignedAt).toISOString()};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
