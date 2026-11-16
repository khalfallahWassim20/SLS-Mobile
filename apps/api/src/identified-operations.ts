/** Prototype isolé, non exposé et non inclus dans les soldes. */
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {assertTourWritable,calculateInvoice} from '@sls/domain';
import {verifyCommercialSession} from './commercial-session.js';
import {lockTourClosure} from './tour-closure-store.js';
import {JournalAuthenticationError,JournalConflict,TourDayClosed} from './journal-store.js';
import {lockIdentifiedOperation,assertOperationUnambiguous,IdentifiedOverlap} from './identified-overlap.js';
import {lockSyncMode,lockSyncModeExclusive,assertIdentifiedMode} from './tour-sync-mode.js';
import {assertLegacyClientDaySafe,lockDayInvoiceClient,assertDayInvoiceAwareSaleSafe} from './day-invoice-legacy-guard.js';
import {assertCreditOperationAvailable,assertInvoiceNotCredited,assertOldCreditProtocolSafe} from './credit-note-active-guards.js';
import {readServerDayInvoiceSource,readSourceForNewIndependentCompensation} from './day-invoice-source.js';
import {readIndependentCompensationProjectionsInTransaction,readCompensatedDayInvoiceSnapshotInTransaction} from './day-invoice-reference.js';
import {readCompensatedJournalDayInTransaction} from './identified-journal-day.js';
import {compensationSchema,compensationHash,compensationRegistryExists} from './day-invoice-compensation.js';
import {assessDayInvoiceSaleRevision,type DayInvoicePayment} from '../../../packages/domain/src/day-invoice.js';

const uuid=z.string().uuid(), money=z.number().int().safe().nonnegative();
export const saleSchema=z.object({createdAt:z.string().datetime(),clientId:uuid,clientName:z.string().min(1).max(200),syncSaleId:uuid,syncVersion:z.number().int().min(1).max(1000000),
 lines:z.array(z.object({name:z.string().min(1).max(200),code:z.string().min(1).max(100),quantity:z.number().int().min(1).max(1000000),unitPrice:money,discount:z.number().int().min(0).max(10000),vat:z.number().int().min(0).max(10000)}).strict()).min(1).max(200),
 total:money,paid:money,remaining:money,paymentMode:z.enum(['Espèces','Chèque','Virement','Crédit']),chequeNumber:z.string().max(100),chequeBank:z.string().max(100),chequeDue:z.string().max(100)}).strict();
export const saleEventSchema=z.object({operationId:uuid,saleId:uuid,version:z.number().int().min(1).max(1000000),recordedAt:z.string().datetime(),sale:saleSchema,refund:money}).strict();
export {settlementSchema} from './settlement-protocol.js';
import {settlementSchema} from './settlement-protocol.js';
type Session={token:string;secret:string;enforceMode?:boolean;creditAware?:boolean;dayInvoiceAware?:boolean};
function tunisDay(iso:string):string {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso));
 const get=(name:string)=>parts.find(p=>p.type===name)?.value;
 return `${get('year')}-${get('month')}-${get('day')}`;
}
function assertOpen(closure:Awaited<ReturnType<typeof lockTourClosure>>) {
 if(closure.status==='closed')throw new TourDayClosed(closure.day,closure.commercialId);
 assertTourWritable(closure);
}
function digest(payload:string) {return createHash('sha256').update(payload).digest('hex');}
async function clientExists(db:PoolClient,id:string) {
 if (!(await db.query('SELECT id FROM clients WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[id])).rows.length) throw new JournalConflict('Client introuvable.');
}
/** L'identité provient exclusivement de la session. Les anciennes opérations ne sont jamais réattribuées. */
export async function storeIdentifiedSale(pool:Pool,input:unknown,session:Session,testGuard?:(db:PoolClient,event:{operationId:string;saleId:string;version:number})=>Promise<void>,compensationInput?:unknown):Promise<'received'|'duplicate'> {
 const event=saleEventSchema.parse(input),sale=event.sale,compensation=compensationInput===undefined?null:compensationSchema.parse(compensationInput);
 if(compensation&&(!session.enforceMode||!session.dayInvoiceAware||testGuard))throw new JournalConflict('Compensation réservée au protocole de facture du jour.');
 if(event.saleId!==sale.syncSaleId || event.version!==sale.syncVersion) throw new RangeError('Identifiants de vente incohérents.');
 const recordedMs=Date.parse(event.recordedAt),createdMs=Date.parse(sale.createdAt);
 if(recordedMs<createdMs || (event.version===1 && recordedMs!==createdMs)) throw new RangeError('Date de l’opération incohérente.');
 const totals=calculateInvoice(sale.lines.map(l=>({quantity:l.quantity,unitPrice:l.unitPrice,discountRate:l.discount,vatRate:l.vat})));
 if(totals.total!==sale.total || sale.remaining!==Math.max(0,sale.total-sale.paid) || (event.version===1 && (event.refund!==0 || sale.paid>sale.total))) throw new RangeError('Totaux de vente incohérents.');
 const day=tunisDay(sale.createdAt),operationDay=tunisDay(event.recordedAt),payload=JSON.stringify(event),hash=digest(payload),db=await pool.connect();
 try {
  await db.query('BEGIN');
  // Toute compensation attend les écritures en cours. Les choix sont
  // sérialisés globalement jusqu'à la validation de toutes leurs preuves ;
  // plusieurs clients indépendants sont acceptés uniquement en test isolé.
  if(session.enforceMode) assertIdentifiedMode(await (compensation?lockSyncModeExclusive(db):lockSyncMode(db)));
  const actor=await verifyCommercialSession(db,session.secret,session.token,true);
  if(!actor) throw new JournalAuthenticationError('Session commerciale invalide ou expirée.');
  await lockIdentifiedOperation(db,event.operationId);
  await assertCreditOperationAvailable(db,event.operationId);
  await assertOperationUnambiguous(db,event.operationId,'sale');
  // La vente est verrouillée avant la lecture de son propriétaire initial.
  // Un verrou sur l'opération et un sur la vente assurent l'idempotence et l'ordre des versions.
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['identified-sale-operation',event.operationId]);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['identified-sale',event.saleId]);
  const same=await db.query('SELECT payload_hash,commercial_id,payload FROM identified_sale_events WHERE operation_id=$1',[event.operationId]);
  const hasCompensationRegistry=await compensationRegistryExists(db);
  if(compensation&&!hasCompensationRegistry)throw new JournalConflict('Registre de compensation indisponible.');
  if(same.rows.length) {
   if(same.rows[0].payload_hash!==hash || same.rows[0].commercial_id!==actor.id) throw new JournalConflict('Identifiant d’opération déjà utilisé.');
   const existing=hasCompensationRegistry?await db.query('SELECT client_id,commercial_id,invoice_day::text AS invoice_day,event_day::text AS event_day,payload,payload_hash FROM identified_day_invoice_compensations WHERE operation_id=$1',[event.operationId]):{rows:[]};
   if((existing.rows.length===1)!==!!compensation)throw new JournalConflict('Reprise de compensation incohérente.');
   if(compensation){const row=existing.rows[0];let valid=false;try{valid=digest(JSON.stringify(saleEventSchema.parse(same.rows[0].payload)))===hash&&row.client_id===sale.clientId&&row.commercial_id===actor.id&&row.invoice_day===day&&row.event_day===operationDay&&compensationHash(compensationSchema.parse(row.payload))===row.payload_hash&&row.payload_hash===compensationHash(compensation);}catch{}if(!valid)throw new JournalConflict('Preuve de compensation incohérente.');}
   await db.query('COMMIT');return 'duplicate';
  }
  if(session.enforceMode&&!session.creditAware)await assertOldCreditProtocolSafe(db);
  await assertInvoiceNotCredited(db,'sale',event.saleId);
  // Crochet uniquement pour les tests du registre d’avoir non exposé.
  if(testGuard)await testGuard(db,event);
  const legacy=await db.query('SELECT version,payload,client_id FROM demo_sale_events WHERE sale_id=$1 ORDER BY version DESC LIMIT 1',[event.saleId]);
  const last=await db.query('SELECT version,payload,commercial_id,journal_date::text AS journal_date FROM identified_sale_events WHERE sale_id=$1 ORDER BY version DESC LIMIT 1',[event.saleId]);
  const first=await db.query('SELECT version,commercial_id,journal_date::text AS journal_date FROM identified_sale_events WHERE sale_id=$1 ORDER BY version ASC LIMIT 1',[event.saleId]);
  if(legacy.rows.length && first.rows.length && first.rows[0].version!==legacy.rows[0].version+1) throw new IdentifiedOverlap('Historique de vente incompatible : rapprochement nécessaire.');
  if(legacy.rows.length && !first.rows.length && event.version!==legacy.rows[0].version+1) throw new IdentifiedOverlap('Vente présente dans l’ancien espace : version suivante requise.');
  if(first.rows.length && first.rows[0].journal_date!==day) throw new JournalConflict('Date de vente incohérente.');
  // Chaque verrou est pris dans un ordre global stable, y compris si deux dates sont concernées.
  const keys=new Map<string,{id:string;day:string}>();
  for (const item of [{id:actor.id,day},{id:actor.id,day:operationDay},...(first.rows.length && !legacy.rows.length?[{id:first.rows[0].commercial_id as string,day}]:[])]) keys.set(`${item.id}:${item.day}`,item);
  for(const key of [...keys.keys()].sort()) {const item=keys.get(key)!; assertOpen(await lockTourClosure(db,item.id,item.day));}
  // Sérialise la création/modification avec les futures écritures client/jour du journal.
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['journal-client-day',`${sale.clientId}:${day}`]);
  await lockDayInvoiceClient(db,sale.clientId);
  if(compensation){
   let existing;try{existing=await readIndependentCompensationProjectionsInTransaction(db);}catch{throw new JournalConflict('Compensations précédentes incohérentes : rapprochement requis.');}
   if(existing.some(p=>p.clientId===sale.clientId))throw new JournalConflict('Client déjà compensé : historique complet requis.');
   if(existing.length>=1000)throw new JournalConflict('Trop de compensations : rapprochement requis.');
  }
  let settledDay=false;
  if(session.dayInvoiceAware)settledDay=await assertDayInvoiceAwareSaleSafe(db,sale.clientId,day,event.version,!!compensation);
  else await assertLegacyClientDaySafe(db,sale.clientId,day);
  const previous=last.rows[0] ?? legacy.rows[0];
  if((previous?.version??0)+1!==event.version) throw new JournalConflict('Version de vente manquante ou déjà utilisée.');
  if(previous) {
   const old=previous.payload?.sale;
   if(!old || (last.rows.length && (typeof previous.payload.recordedAt!=='string' || recordedMs<Date.parse(previous.payload.recordedAt)))) throw new JournalConflict('Date ou historique de modification incohérent.');
   if((last.rows.length && previous.journal_date!==day) || old.clientId!==sale.clientId || old.createdAt!==sale.createdAt || sale.paid!==old.paid-event.refund || event.refund>Math.max(0,old.paid-sale.total)) throw new JournalConflict('Modification ou attribution incohérente.');
  }
  if(settledDay){
   // Le champ historique refund ne peut pas exprimer un paiement unifié.
   // Un choix dédié est admis uniquement par l'appel interne préparatoire.
   if(event.refund!==0)throw new JournalConflict('Remboursement d’une facture du jour réglée : rapprochement requis.');
   const source=await (compensation?readSourceForNewIndependentCompensation:readServerDayInvoiceSource)(db,{clientId:sale.clientId,day} as DayInvoicePayment);
   if(compensation){
    const paymentTimes=await db.query('SELECT payload FROM identified_day_invoice_payments WHERE client_id=$1 AND invoice_day=$2::date',[sale.clientId,day]);
    if(paymentTimes.rows.some(r=>typeof r.payload?.recordedAt!=='string'||!Number.isFinite(Date.parse(r.payload.recordedAt))||Date.parse(r.payload.recordedAt)>recordedMs))throw new JournalConflict('Modification antérieure à un paiement : rapprochement requis.');
   }
   const before=source.sales.find(s=>s.id===event.saleId);
   if(!before||before.version!==event.version-1||before.total!==previous?.payload?.sale?.total||before.paid!==previous?.payload?.sale?.paid)throw new JournalConflict('Vente ou facture du jour modifiée : actualisation nécessaire.');
   try{
    const computed=assessDayInvoiceSaleRevision(source,event.saleId,sale.total);
    if(compensation){if(!computed.requiresChoice||computed.excess!==compensation.amount||computed.previousTotal!==compensation.previousTotal||computed.paid!==compensation.paid)throw Error('Choix ou facture modifiés.');}
    else if(computed.requiresChoice)throw Error('Paiement supérieur au total modifié.');
   }catch{throw new JournalConflict('Total modifié ou compensation incohérente : choix remboursement ou crédit requis.');}
  } else if(compensation)throw new JournalConflict('Aucun règlement unifié ne justifie cette compensation.');
  await clientExists(db,sale.clientId);
  await db.query('INSERT INTO identified_sale_events(operation_id,sale_id,version,client_id,commercial_id,journal_date,event_date,payload,payload_hash) VALUES($1,$2,$3,$4,$5,$6::date,$7::date,$8::jsonb,$9)',[event.operationId,event.saleId,event.version,sale.clientId,actor.id,day,operationDay,payload,hash]);
  if(compensation){
   await db.query('INSERT INTO identified_day_invoice_compensations(operation_id,client_id,commercial_id,invoice_day,event_day,payload,payload_hash) VALUES($1,$2,$3,$4::date,$5::date,$6::jsonb,$7)',[event.operationId,sale.clientId,actor.id,day,operationDay,JSON.stringify(compensation),compensationHash(compensation)]);
   // Ne jamais valider une écriture que les lecteurs de reprise ne peuvent
   // pas prouver. En particulier une ancienne version issue du registre démo
   // ou une preuve historique altérée doit annuler les deux insertions.
   try{
    const snapshot=await readCompensatedDayInvoiceSnapshotInTransaction(db,event.operationId);
    const journal=await readCompensatedJournalDayInTransaction(db,actor.id,operationDay,event.operationId);
    const row=journal.rows.filter(r=>r.clientId===sale.clientId);
    if(snapshot.compensation.commercialId!==actor.id||row.length!==1||row[0].compensationRefund!==snapshot.compensation.refund||row[0].compensationCredit!==snapshot.compensation.credit)throw Error('Journal de compensation incohérent.');
   }catch{throw new JournalConflict('Preuve de compensation non vérifiable : opération annulée, rapprochement nécessaire.');}
  }
  await db.query('COMMIT');return 'received';
 } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
/** Révision et choix écrits atomiquement ; transport réservé aux tests isolés.
 * Les lectures et clôtures ordinaires restent bloquées après compensation. */
export async function storeDayInvoiceCompensatedSale(pool:Pool,input:unknown,choice:unknown,session:{token:string;secret:string}){
 return storeIdentifiedSale(pool,input,{...session,enforceMode:true,dayInvoiceAware:true},undefined,compensationSchema.parse(choice));
}
export async function storeIdentifiedSettlement(pool:Pool,input:unknown,session:Session):Promise<'received'|'duplicate'> {
 const event=settlementSchema.parse(input),p=event.settlement;
 if(event.operationId!==p.syncOperationId || (p.mode==='Chèque' && (!p.chequeNumber.trim() || !p.chequeBank.trim() || !p.chequeDue.trim()))) throw new RangeError('Règlement incohérent.');
 const day=tunisDay(p.createdAt),payload=JSON.stringify(event),hash=digest(payload),db=await pool.connect();
 try {
  await db.query('BEGIN');
  if(session.enforceMode) assertIdentifiedMode(await lockSyncMode(db));
  const actor=await verifyCommercialSession(db,session.secret,session.token,true);
  if(!actor) throw new JournalAuthenticationError('Session commerciale invalide ou expirée.');
  await lockIdentifiedOperation(db,event.operationId);
  await assertCreditOperationAvailable(db,event.operationId);
  await assertOperationUnambiguous(db,event.operationId,'settlement');
  const closure=await lockTourClosure(db,actor.id,day);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['identified-settlement',event.operationId]);
  const same=await db.query('SELECT payload_hash,commercial_id FROM identified_settlements WHERE operation_id=$1',[event.operationId]);
  if(same.rows.length) {
   if(same.rows[0].payload_hash!==hash || same.rows[0].commercial_id!==actor.id) throw new JournalConflict('Identifiant d’opération déjà utilisé.');
   await db.query('COMMIT');return 'duplicate';
  }
  if(session.enforceMode&&!session.creditAware)await assertOldCreditProtocolSafe(db);
  assertOpen(closure);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['journal-client-day',`${p.clientId}:${day}`]);
  await lockDayInvoiceClient(db,p.clientId);
  await assertLegacyClientDaySafe(db,p.clientId,day);
  await clientExists(db,p.clientId);
  await db.query('INSERT INTO identified_settlements(operation_id,client_id,commercial_id,journal_date,payload,payload_hash) VALUES($1,$2,$3,$4::date,$5::jsonb,$6)',[event.operationId,p.clientId,actor.id,day,payload,hash]);
  await db.query('COMMIT');return 'received';
 } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
