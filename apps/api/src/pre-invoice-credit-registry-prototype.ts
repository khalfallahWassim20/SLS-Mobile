/** Réservé aux tests : aucun montage HTTP. La migration crée des tables vides. Ne modifie
 * ni les soldes, ni les opérations de journal utilisées par l'application. */
import type {Pool} from 'pg';
import {z} from 'zod';
import {calculatePreInvoiceCancellation,canonicalJson,type CreditNoteActor} from '@sls/domain';
import {verifyCommercialSession} from './commercial-session.js';
import {assertIdentifiedMode,lockSyncModeExclusive} from './tour-sync-mode.js';
import {lockIdentifiedOperation,assertOperationUnambiguous,IdentifiedOverlap} from './identified-overlap.js';
import {lockTourClosure} from './tour-closure-store.js';
import {JournalAuthenticationError,JournalConflict,TourDayClosed} from './journal-store.js';
import {parseJournalSnapshot,validateJournalTransition,type JournalSnapshot} from './journal-protocol.js';

export const preInvoiceCreditPrototypeSchema=`CREATE TABLE IF NOT EXISTS pre_invoice_credit_prototype_events (
 operation_id uuid PRIMARY KEY, invoice_id uuid NOT NULL UNIQUE, event jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pre_invoice_credit_prototype_movements (
 operation_id uuid NOT NULL REFERENCES pre_invoice_credit_prototype_events(operation_id),
 kind text NOT NULL CHECK(kind IN ('invoice_cancellation','refund')),
 balance_delta bigint NOT NULL, PRIMARY KEY(operation_id,kind)
)`;
const inputSchema=z.object({operationId:z.string().uuid(),invoiceId:z.string().uuid(),expectedVersion:z.number().int().min(1).max(999999),recordedAt:z.string().datetime({precision:3}),choice:z.enum(['refund','credit']).nullable()}).strict();
type Principal={kind:'commercial';secret:string;token:string}|{kind:'admin';actorId:string};
function tunisDay(iso:string) {
 const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso));
 return ['year','month','day'].map(k=>p.find(v=>v.type===k)?.value).join('-');
}
/** L'identité admin vient impérativement d'un middleware authentifié. Les
 * règles de contrôle après annulation dans les autres flux ne sont pas encore
 * raccordées : ce prototype ne doit en aucun cas être exposé en production. */
export async function storePrototypePreInvoiceCredit(pool:Pool,raw:unknown,principal:Principal) {
 const command=inputSchema.parse(raw);
 if(new Date(command.recordedAt).toISOString()!==command.recordedAt)throw new RangeError('Date invalide.');
 const db=await pool.connect();
 try {
  await db.query('BEGIN');assertIdentifiedMode(await lockSyncModeExclusive(db));
  let actor:CreditNoteActor;
  if(principal.kind==='commercial') {
   const c=await verifyCommercialSession(db,principal.secret,principal.token,true);
   if(!c)throw new JournalAuthenticationError('Session commerciale invalide ou expirée.');
   actor={id:c.id,role:'commercial'};
  } else {
   if(typeof principal.actorId!=='string'||!principal.actorId.trim()||principal.actorId.length>200)throw new JournalAuthenticationError('Administrateur requis.');
   actor={id:principal.actorId,role:'admin'};
  }
  await lockIdentifiedOperation(db,command.operationId);
  await assertOperationUnambiguous(db,command.operationId,'journal');
  const collision=await db.query('SELECT 1 FROM identified_journal_events WHERE operation_id=$1 UNION ALL SELECT 1 FROM credit_note_prototype_events WHERE operation_id=$1',[command.operationId]);
  if(collision.rows.length)throw new IdentifiedOverlap('Identifiant d’opération déjà utilisé.');
  const duplicate=await db.query('SELECT event FROM pre_invoice_credit_prototype_events WHERE operation_id=$1',[command.operationId]);
  if(duplicate.rows.length) {
   const event=duplicate.rows[0].event;
   if(canonicalJson(event.command)!==canonicalJson(command)||canonicalJson(event.actor)!==canonicalJson(actor))throw new JournalConflict('Identifiant d’opération déjà utilisé avec un autre contenu ou acteur.');
   await db.query('COMMIT');return {status:'duplicate' as const,event};
  }
  const used=await db.query('SELECT 1 FROM credit_note_prototype_operation_ids WHERE operation_id=$1',[command.operationId]);
  if(used.rows.length)throw new JournalConflict('Identifiant d’opération déjà utilisé par un autre avoir.');
  const info=await db.query('SELECT client_id,commercial_id,journal_date::text AS day FROM identified_journal_invoices WHERE id=$1',[command.invoiceId]);
  const meta=info.rows[0];
  if(!meta||!meta.commercial_id)throw new IdentifiedOverlap('Facture préétablie non identifiée : rapprochement nécessaire.');
  const legacy=await db.query('SELECT 1 FROM sync_journal_invoices WHERE id=$1',[command.invoiceId]);
  if(legacy.rows.length)throw new IdentifiedOverlap('Ancienne facture préétablie : rapprochement nécessaire.');
  const keys=new Map<string,{id:string;day:string}>();
  const add=(id:string,day:string)=>keys.set(`${id}:${day}`,{id,day});
  add(meta.commercial_id,meta.day);add(meta.commercial_id,tunisDay(command.recordedAt));
  if(actor.role==='commercial'){add(actor.id,meta.day);add(actor.id,tunisDay(command.recordedAt));}
  // Même ordre que l'écriture de journal : clôtures avant verrou de facture.
  for(const key of [...keys.keys()].sort()){
   const k=keys.get(key)!;const state=await lockTourClosure(db,k.id,k.day);
   if(state.status!=='open')throw new TourDayClosed(k.day,k.id);
  }
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',['journal-invoice',command.invoiceId]);
  const prior=await db.query('SELECT 1 FROM pre_invoice_credit_prototype_events WHERE invoice_id=$1',[command.invoiceId]);
  if(prior.rows.length)throw new JournalConflict('Facture déjà annulée.');
  const rows=await db.query('SELECT version,payload FROM identified_journal_events WHERE invoice_id=$1 ORDER BY version',[command.invoiceId]);
  if(!rows.rows.length||rows.rows.some((r,i)=>r.version!==i+1))throw new JournalConflict('Historique de facture incomplet.');
  const latest=rows.rows[rows.rows.length-1];
  if(latest.version!==command.expectedVersion)throw new JournalConflict('Version de facture périmée.');
  let previous:JournalSnapshot|null=null;
  try {
   for(const row of rows.rows) {
    const current=parseJournalSnapshot(row.payload);
    if(current.version!==row.version||(!previous&&current.receipts.length))throw new RangeError('Historique initial incohérent');
    validateJournalTransition(previous,current);previous=current;
   }
  } catch {throw new JournalConflict('Historique de facture incohérent.');}
  const snapshot=previous!;
  if(snapshot.invoice.id!==command.invoiceId||snapshot.invoice.clientId!==meta.client_id||snapshot.invoice.journalDate!==meta.day)throw new JournalConflict('Facture incohérente.');
  const lastDate=Math.max(Date.parse(snapshot.invoice.createdAt),...snapshot.receipts.map(r=>Date.parse(r.createdAt)));
  if(!Number.isFinite(lastDate)||Date.parse(command.recordedAt)<lastDate)throw new JournalConflict('Date de l’avoir antérieure à la facture ou à un paiement.');
  const calculated=calculatePreInvoiceCancellation({balance:0,invoiceTotal:snapshot.invoice.amount,receipts:snapshot.receipts,alreadyCancelled:false,choice:command.choice??undefined});
  const event={command,actor,source:snapshot,clientId:meta.client_id,ownerId:meta.commercial_id,...calculated};
  await db.query('INSERT INTO credit_note_prototype_operation_ids(operation_id) VALUES($1)',[command.operationId]);
  await db.query('INSERT INTO pre_invoice_credit_prototype_events(operation_id,invoice_id,event) VALUES($1,$2,$3::jsonb)',[command.operationId,command.invoiceId,JSON.stringify(event)]);
  // Retirer la contribution courante, puis enregistrer la sortie éventuelle.
  // Si la facture n'avait pas été déclarée elle ne contribue pas au solde.
  const invoiceDelta=calculated.wasDeclared ? -snapshot.invoice.amount : 0;
  await db.query('INSERT INTO pre_invoice_credit_prototype_movements(operation_id,kind,balance_delta) VALUES($1,$2,$3)',[command.operationId,'invoice_cancellation',invoiceDelta]);
  if(calculated.refund>0)await db.query('INSERT INTO pre_invoice_credit_prototype_movements(operation_id,kind,balance_delta) VALUES($1,$2,$3)',[command.operationId,'refund',calculated.refund]);
  await db.query('COMMIT');return {status:'received' as const,event};
 } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
