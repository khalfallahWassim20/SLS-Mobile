/** Abandon idempotent d'une demande d'avoir jamais reçue, sous les mêmes
 * verrous que sa création. Ne supprime ni facture, ni avoir, ni mouvement. */
import {z} from 'zod';
import {canonicalJson} from '@sls/domain';
import type {Pool} from 'pg';
import {verifyCommercialSession} from './commercial-session.js';
import {assertIdentifiedMode,lockSyncModeExclusive} from './tour-sync-mode.js';
import {lockIdentifiedOperation,assertOperationUnambiguous} from './identified-overlap.js';
import {JournalAuthenticationError,JournalConflict} from './journal-store.js';
const commandSchema=z.object({operationId:z.string().uuid(),invoiceId:z.string().uuid(),expectedVersion:z.number().int().min(1).max(999999),recordedAt:z.string().datetime({precision:3}),choice:z.enum(['refund','credit']).nullable()}).strict();
export const creditAbandonInputSchema=z.object({kind:z.enum(['sale','preinvoice']),command:commandSchema}).strict();
export async function abandonCreditNotePrototype(pool:Pool,raw:unknown,session:{secret:string;token:string}){
 const {kind,command}=creditAbandonInputSchema.parse(raw),db=await pool.connect();
 try{
  await db.query('BEGIN');assertIdentifiedMode(await lockSyncModeExclusive(db));
  const commercial=await verifyCommercialSession(db,session.secret,session.token,true);if(!commercial)throw new JournalAuthenticationError('Session invalide ou expirée.');
  const actor={id:commercial.id,role:'commercial'};await lockIdentifiedOperation(db,command.operationId);
  const old=await db.query('SELECT kind,invoice_id,commercial_id,command FROM credit_note_abandon_prototype WHERE operation_id=$1',[command.operationId]);
  if(old.rows.length){const x=old.rows[0];if(x.kind!==kind||x.invoice_id!==command.invoiceId||x.commercial_id!==commercial.id||canonicalJson(x.command)!==canonicalJson(command))throw new JournalConflict('Identifiant d’avoir déjà utilisé.');await db.query('COMMIT');return {status:'abandoned' as const,kind,operationId:command.operationId,invoiceId:command.invoiceId};}
  await assertOperationUnambiguous(db,command.operationId,kind==='sale'?'sale':'journal');
  const [sales,pre]=await Promise.all([db.query('SELECT event FROM credit_note_prototype_events WHERE operation_id=$1',[command.operationId]),db.query('SELECT event FROM pre_invoice_credit_prototype_events WHERE operation_id=$1',[command.operationId])]);
  const existing=kind==='sale'?sales.rows[0]:pre.rows[0];
  if(existing){if((kind==='sale'?pre:sales).rows.length||canonicalJson(existing.event.command)!==canonicalJson(command)||canonicalJson(existing.event.actor)!==canonicalJson(actor))throw new JournalConflict('Identifiant d’avoir déjà utilisé.');await db.query('COMMIT');return {status:'already-received' as const,kind,operationId:command.operationId,invoiceId:command.invoiceId};}
  if(sales.rows.length||pre.rows.length||(await db.query('SELECT 1 FROM credit_note_prototype_operation_ids WHERE operation_id=$1',[command.operationId])).rows.length)throw new JournalConflict('Identifiant d’avoir déjà utilisé.');
  const occupied=await db.query('SELECT 1 FROM identified_sale_events WHERE operation_id=$1 UNION ALL SELECT 1 FROM identified_journal_events WHERE operation_id=$1',[command.operationId]);if(occupied.rows.length)throw new JournalConflict('Identifiant d’opération déjà utilisé.');
  const exists=kind==='sale'?await db.query('SELECT 1 FROM identified_sale_events WHERE sale_id=$1 AND version=1',[command.invoiceId]):await db.query('SELECT 1 FROM identified_journal_invoices WHERE id=$1',[command.invoiceId]);
  if(!exists.rows.length)throw new JournalConflict('Facture synchronisée introuvable.');
  await db.query('INSERT INTO credit_note_prototype_operation_ids(operation_id) VALUES($1)',[command.operationId]);
  await db.query('INSERT INTO credit_note_abandon_prototype(operation_id,kind,invoice_id,commercial_id,command) VALUES($1,$2,$3,$4,$5::jsonb)',[command.operationId,kind,command.invoiceId,commercial.id,JSON.stringify(command)]);
  await db.query('COMMIT');return {status:'abandoned' as const,kind,operationId:command.operationId,invoiceId:command.invoiceId};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
