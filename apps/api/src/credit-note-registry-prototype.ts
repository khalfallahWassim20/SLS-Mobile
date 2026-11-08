/** EXPÉRIMENTAL : ce registre ne modifie pas les soldes ni la facture.
 * Aucune route ne doit l'appeler. Son schéma n'est PAS dans la migration de
 * l'application : il est réservé aux bases de test isolées. Avant activation,
 * intégrer ce registre aux projections et à TOUS les chemins d'écriture. */
import type {Pool} from 'pg';
import {z} from 'zod';
import {prepareFullCreditNote,type CreditNoteActor,type CreditNoteEvent} from '@sls/domain';
import {verifyCommercialSession} from './commercial-session.js';
import {JournalAuthenticationError,JournalConflict} from './journal-store.js';
import {lockIdentifiedOperation} from './identified-overlap.js';
import {assertIdentifiedMode,lockSyncMode} from './tour-sync-mode.js';
import {lockCreditNoteSale} from './credit-note-sale-lock.js';

export const creditNotePrototypeSchema=`CREATE TABLE credit_note_prototype_operation_ids (operation_id uuid PRIMARY KEY);
CREATE TABLE credit_note_prototype_events (
 operation_id uuid PRIMARY KEY, invoice_id uuid NOT NULL UNIQUE,
 event jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credit_note_prototype_movements (
 operation_id uuid NOT NULL REFERENCES credit_note_prototype_events(operation_id),
 kind text NOT NULL CHECK(kind IN ('invoice_cancellation','refund')),
 balance_delta bigint NOT NULL,
 PRIMARY KEY(operation_id,kind)
)`;
const inputSchema=z.object({operationId:z.string().uuid(),invoiceId:z.string().uuid(),expectedVersion:z.number().int().min(1).max(999999),recordedAt:z.string().datetime({precision:3}),choice:z.enum(['refund','credit']).nullable()}).strict();
type Principal={kind:'commercial';secret:string;token:string}|{kind:'admin';actorId:string};
/** Le principal admin est supposé fourni par un middleware vérifié, jamais par
 * un corps HTTP. La vérification du commercial a lieu dans la transaction. */
export async function storePrototypeCreditNote(pool:Pool,raw:unknown,principal:Principal) {
 const command=inputSchema.parse(raw),db=await pool.connect();
 try {
  await db.query('BEGIN');
  assertIdentifiedMode(await lockSyncMode(db));
  let actor:CreditNoteActor;
  if(principal.kind==='commercial') {
   const commercial=await verifyCommercialSession(db,principal.secret,principal.token,true);
   if(!commercial)throw new JournalAuthenticationError('Session commerciale invalide ou expirée.');
   actor={id:commercial.id,role:'commercial'};
  } else {
   if(typeof principal.actorId!=='string'||!principal.actorId.trim()||principal.actorId.length>200)throw new JournalAuthenticationError('Administrateur requis.');
   actor={id:principal.actorId,role:'admin'};
  }
  await lockIdentifiedOperation(db,command.operationId);
  // Défense contre les UUID déjà occupés par une opération d'un autre type.
  const collision=await db.query(`SELECT EXISTS(SELECT 1 FROM demo_sale_events WHERE operation_id=$1)
   OR EXISTS(SELECT 1 FROM demo_settlements WHERE operation_id=$1)
   OR EXISTS(SELECT 1 FROM sync_journal_events WHERE operation_id=$1)
   OR EXISTS(SELECT 1 FROM identified_sale_events WHERE operation_id=$1)
   OR EXISTS(SELECT 1 FROM identified_settlements WHERE operation_id=$1)
   OR EXISTS(SELECT 1 FROM identified_journal_events WHERE operation_id=$1) AS conflict`,[command.operationId]);
  if(collision.rows[0]?.conflict!==false)throw new JournalConflict('Identifiant d’opération déjà utilisé.');
  const existing=await db.query('SELECT event FROM credit_note_prototype_events WHERE operation_id=$1',[command.operationId]);
  if(existing.rows.length) {
   const result=prepareFullCreditNote({actor,command,source:{invoiceId:command.invoiceId,version:command.expectedVersion,total:0,netPaid:0,cancelled:false},daysOpen:false,previous:existing.rows[0].event as CreditNoteEvent});
   await db.query('COMMIT');return result;
  }
  const used=await db.query('SELECT 1 FROM credit_note_prototype_operation_ids WHERE operation_id=$1',[command.operationId]);
  if(used.rows.length)throw new JournalConflict('Identifiant d’opération déjà utilisé par un autre avoir.');
  const source=await lockCreditNoteSale(db,actor,command);
  // Ce contrôle est effectué après acquisition du verrou partagé avec les ventes.
  const prior=await db.query('SELECT 1 FROM credit_note_prototype_events WHERE invoice_id=$1',[command.invoiceId]);
  if(prior.rows.length)throw new JournalConflict('Facture déjà annulée.');
  const result=prepareFullCreditNote({actor,command,source:{invoiceId:source.invoiceId,version:source.version,total:source.total,netPaid:source.netPaid,cancelled:false},daysOpen:true,previous:null});
  await db.query('INSERT INTO credit_note_prototype_operation_ids(operation_id) VALUES($1)',[command.operationId]);
  await db.query('INSERT INTO credit_note_prototype_events(operation_id,invoice_id,event) VALUES($1,$2,$3::jsonb)',[command.operationId,command.invoiceId,JSON.stringify(result.event)]);
  // Ces mouvements ne sont pas raccordés aux soldes actifs. Leur somme est
  // le delta sur le solde client (positif = dette ; remboursement = sortie).
  await db.query('INSERT INTO credit_note_prototype_movements(operation_id,kind,balance_delta) VALUES($1,$2,$3)',[command.operationId,'invoice_cancellation',-result.event.noteTotal]);
  if(result.event.refund>0)await db.query('INSERT INTO credit_note_prototype_movements(operation_id,kind,balance_delta) VALUES($1,$2,$3)',[command.operationId,'refund',result.event.refund]);
  await db.query('COMMIT');return result;
 } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
