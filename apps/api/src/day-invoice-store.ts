/** Stockage serveur isolé pour la facture du jour. Aucune route ne l'expose.
 * Le raccordement exige que toutes les écritures de vente partagent le verrou
 * client/jour et que les projections de solde intègrent cette table. */
import type {Pool,PoolClient} from 'pg';
import {assertTourWritable} from '@sls/domain';
import {validateDayInvoiceWrite,type DayInvoicePayment} from '../../../packages/domain/src/day-invoice.js';
import {dayInvoicePaymentHash,parseDayInvoicePayment,parseStoredDayInvoicePayment} from './day-invoice-protocol.js';
import {verifyCommercialSession} from './commercial-session.js';
import {lockTourClosure} from './tour-closure-store.js';
import {JournalAuthenticationError,JournalConflict,TourDayClosed} from './journal-store.js';
import {lockIdentifiedOperation,assertOperationUnambiguous} from './identified-overlap.js';
import {lockSyncMode,assertIdentifiedMode} from './tour-sync-mode.js';
import {lockDayInvoiceClient} from './day-invoice-legacy-guard.js';
import {assertCreditOperationAvailable,assertInvoiceNotCredited,assertOldCreditProtocolSafe} from './credit-note-active-guards.js';
import {assertDayPaymentChronology} from './day-invoice-payment-chronology.js';

// Réexport conservé pour les tests et consommateurs existants.
export {dayInvoiceServerSchema} from './day-invoice-schema.js';
type Source=Parameters<typeof validateDayInvoiceWrite>[1];
type Session={token:string;secret:string};
function tunisDay(iso:string):string {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso));
 const get=(key:string)=>parts.find(p=>p.type===key)?.value;
 return `${get('year')}-${get('month')}-${get('day')}`;
}
/** Le lecteur est une dépendance obligatoire : il doit lire TOUTES les sources
 * et tous les paiements du client/jour avec le même client PG et ses verrous. */
export async function storeDayInvoicePayment(pool:Pool,input:unknown,session:Session,readSource:(db:PoolClient,event:DayInvoicePayment)=>Promise<Source>):Promise<'received'|'duplicate'> {
 const event=parseDayInvoicePayment(input),hash=dayInvoicePaymentHash(event),db=await pool.connect();
 try {
  await db.query('BEGIN');
  assertIdentifiedMode(await lockSyncMode(db));
  const actor=await verifyCommercialSession(db,session.secret,session.token,true);
  if(!actor)throw new JournalAuthenticationError('Session commerciale invalide ou expirée.');
  await lockIdentifiedOperation(db,event.operationId);
  await assertCreditOperationAvailable(db,event.operationId);
  const existing=await db.query('SELECT operation_id,client_id,invoice_day::text AS invoice_day,event_day::text AS event_day,payload,payload_hash,commercial_id FROM identified_day_invoice_payments WHERE operation_id=$1',[event.operationId]);
  if(existing.rows.length) {
   if(existing.rows[0].payload_hash!==hash || existing.rows[0].commercial_id!==actor.id)throw new JournalConflict('Identifiant de paiement déjà utilisé.');
   try {parseStoredDayInvoicePayment(existing.rows[0]);} catch {throw new JournalConflict('Paiement du jour enregistré incohérent : rapprochement requis.');}
   await db.query('COMMIT');return 'duplicate';
  }
  await assertOperationUnambiguous(db,event.operationId,'settlement');
  if((await db.query('SELECT 1 FROM identified_settlements WHERE operation_id=$1',[event.operationId])).rows.length)throw new JournalConflict('Identifiant déjà utilisé par un règlement.');
  await assertOldCreditProtocolSafe(db);
  // Même ordre que les ventes identifiées : vente(s), clôture(s), facture, client/jour.
  for(const sale of event.sales)await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['identified-sale',sale.id]);
  // Une première déclaration modifie le journal du propriétaire de la
  // préétablie, même si un autre commercial encaisse un autre jour. Il faut
  // donc sérialiser aussi avec la clôture de ce propriétaire.
  let owner:string|null=null;
  if(event.preInvoice?.declare){
   const invoice=await db.query('SELECT client_id,journal_date::text AS day,commercial_id FROM identified_journal_invoices WHERE id=$1',[event.preInvoice.id]);
   if(invoice.rows.length!==1||invoice.rows[0].client_id!==event.clientId||invoice.rows[0].day!==event.day)throw new JournalConflict('Facture à déclarer indisponible : synchronisez avant règlement.');
   owner=invoice.rows[0].commercial_id;
  }
  const closures=new Map<string,{id:string;day:string}>();
  for(const day of [event.day,tunisDay(event.recordedAt)])closures.set(`${actor.id}:${day}`,{id:actor.id,day});
  if(owner)closures.set(`${owner}:${event.day}`,{id:owner,day:event.day});
  for(const key of [...closures.keys()].sort()){const item=closures.get(key)!;const closure=await lockTourClosure(db,item.id,item.day);if(closure.status==='closed')throw new TourDayClosed(item.day,item.id);assertTourWritable(closure);}
  if(event.preInvoice)await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['journal-invoice',event.preInvoice.id]);
  if(event.preInvoice?.declare){
   const invoice=await db.query('SELECT client_id,journal_date::text AS day,commercial_id FROM identified_journal_invoices WHERE id=$1',[event.preInvoice.id]);
   if(invoice.rows.length!==1||invoice.rows[0].client_id!==event.clientId||invoice.rows[0].day!==event.day||invoice.rows[0].commercial_id!==owner)throw new JournalConflict('Propriétaire de facture modifié : synchronisez avant règlement.');
  }
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['journal-client-day',`${event.clientId}:${event.day}`]);
  await lockDayInvoiceClient(db,event.clientId);
  if(event.preInvoice)await assertInvoiceNotCredited(db,'preinvoice',event.preInvoice.id);
  for(const sale of event.sales)await assertInvoiceNotCredited(db,'sale',sale.id);
  const source=await readSource(db,event);
  try {validateDayInvoiceWrite(event,source);await assertDayPaymentChronology(db,event);}catch(error){throw new JournalConflict(error instanceof Error?error.message:'Facture du jour incohérente.');}
  await db.query('INSERT INTO identified_day_invoice_payments(operation_id,client_id,commercial_id,invoice_day,event_day,payload,payload_hash) VALUES($1,$2,$3,$4::date,$5::date,$6::jsonb,$7)',[event.operationId,event.clientId,actor.id,event.day,tunisDay(event.recordedAt),JSON.stringify(event),hash]);
  await db.query('COMMIT');return 'received';
 } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
