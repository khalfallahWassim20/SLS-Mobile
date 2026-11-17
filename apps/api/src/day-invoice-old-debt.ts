/** Règlement explicitement distinct de la facture du jour. Route de test v6
 * seulement ; reçu, marqueur et contrôle du solde sont une transaction. */
import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {calculateDayInvoice,availablePriorDebt} from '../../../packages/domain/src/day-invoice.js';
import {settlementSchema,parseStoredOldDebt} from './settlement-protocol.js';
import {verifyCommercialSession} from './commercial-session.js';
import {lockSyncMode,assertIdentifiedMode} from './tour-sync-mode.js';
import {lockIdentifiedOperation,assertOperationUnambiguous} from './identified-overlap.js';
import {assertCreditOperationAvailable,assertOldCreditProtocolSafe} from './credit-note-active-guards.js';
import {assertDayInvoiceCloseRegistry,lockDayInvoiceClient} from './day-invoice-legacy-guard.js';
import {lockTourClosure} from './tour-closure-store.js';
import {JournalAuthenticationError,JournalConflict,TourDayClosed} from './journal-store.js';
import {readDayInvoiceReferenceInTransaction} from './day-invoice-reference.js';
import {readServerDayInvoiceSource} from './day-invoice-source.js';
import type {DayInvoicePayment} from '../../../packages/domain/src/day-invoice.js';
import {assertTourWritable} from '@sls/domain';
const request=z.object({invoiceDay:z.string(),event:settlementSchema}).strict();
function tunisDay(iso:string){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso));return `${p.find(x=>x.type==='year')?.value}-${p.find(x=>x.type==='month')?.value}-${p.find(x=>x.type==='day')?.value}`;}
export async function storeDayInvoiceOldDebt(pool:Pool,input:unknown,session:{token:string;secret:string}):Promise<'received'|'duplicate'>{
 const {invoiceDay,event}=request.parse(input),p=event.settlement;
 const date=new Date(`${invoiceDay}T00:00:00.000Z`);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDay)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==invoiceDay||tunisDay(p.createdAt)!==invoiceDay||event.operationId!==p.syncOperationId||(p.mode==='Chèque'&&(!p.chequeNumber.trim()||!p.chequeBank.trim()||!p.chequeDue.trim()))||(p.mode!=='Chèque'&&(p.chequeNumber||p.chequeBank||p.chequeDue)))throw new RangeError('Règlement ancienne dette invalide.');
 const payload=JSON.stringify(event),hash=createHash('sha256').update(payload).digest('hex'),db=await pool.connect();
 try{
  await db.query('BEGIN');assertIdentifiedMode(await lockSyncMode(db));const actor=await verifyCommercialSession(db,session.secret,session.token,true);if(!actor)throw new JournalAuthenticationError('Session commerciale invalide ou expirée.');
  await lockIdentifiedOperation(db,event.operationId);await assertCreditOperationAvailable(db,event.operationId);await assertOperationUnambiguous(db,event.operationId,'settlement');
  const closure=await lockTourClosure(db,actor.id,invoiceDay);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['identified-settlement',event.operationId]);
  const same=await db.query('SELECT s.operation_id,s.client_id,s.journal_date::text AS journal_day,s.payload,s.payload_hash,s.commercial_id,m.invoice_day::text AS invoice_day FROM identified_settlements s LEFT JOIN identified_day_invoice_old_debt m ON m.operation_id=s.operation_id WHERE s.operation_id=$1',[event.operationId]);
  if(same.rows.length){if(same.rows[0].payload_hash!==hash||same.rows[0].commercial_id!==actor.id||same.rows[0].invoice_day!==invoiceDay)throw new JournalConflict('Identifiant de règlement déjà utilisé.');try{parseStoredOldDebt(same.rows[0]);}catch{throw new JournalConflict('Règlement ancienne dette enregistré incohérent : rapprochement requis.');}await db.query('COMMIT');return 'duplicate';}
  // Une réponse perdue doit pouvoir être redemandée après une compensation
  // ou une clôture. Les gardes s'appliquent aux écritures nouvelles seulement.
  await assertDayInvoiceCloseRegistry(db);await assertOldCreditProtocolSafe(db);if(closure.status==='closed')throw new TourDayClosed(invoiceDay,actor.id);assertTourWritable(closure);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['journal-client-day',`${p.clientId}:${invoiceDay}`]);await lockDayInvoiceClient(db,p.clientId);
  const client=await db.query('SELECT id FROM clients WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[p.clientId]);if(!client.rows.length)throw new JournalConflict('Client introuvable.');
  const source=await readServerDayInvoiceSource(db,{clientId:p.clientId,day:invoiceDay} as DayInvoicePayment);
  const reference=await readDayInvoiceReferenceInTransaction(db,true),balance=reference.clients.find(c=>c.id===p.clientId)?.serverBalance;
  if(balance===undefined)throw new JournalConflict('Solde client indisponible.');
  const available=availablePriorDebt(Number(balance),calculateDayInvoice(source));if(p.amount>available)throw new JournalConflict('Règlement supérieur à l’ancienne dette disponible.');
  await db.query('INSERT INTO identified_settlements(operation_id,client_id,commercial_id,journal_date,payload,payload_hash) VALUES($1,$2,$3,$4::date,$5::jsonb,$6)',[event.operationId,p.clientId,actor.id,invoiceDay,payload,hash]);
  await db.query('INSERT INTO identified_day_invoice_old_debt(operation_id,invoice_day) VALUES($1,$2::date)',[event.operationId,invoiceDay]);
  await db.query('COMMIT');return 'received';
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
