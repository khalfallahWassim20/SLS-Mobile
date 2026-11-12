/** Préparation serveur isolée. Aucune route ne doit exposer une clôture avant raccordement
 * atomique à toutes les écritures et contrôle des opérations hors ligne. */
import {randomUUID,createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {initialTourClosure,transitionTourClosure,canonicalJson,cashClosureCanonical,type TourActor,type TourClosureState} from '@sls/domain';
import {journalDateSchema} from './journal-protocol.js';
import {lockSyncMode,assertIdentifiedMode} from './tour-sync-mode.js';
import {assertOldCreditProtocolSafe} from './credit-note-active-guards.js';
import {assertSaleRefundJournalSafe} from './sale-refund-journal-guard-prototype.js';
import {readPrototypeCreditHistoryInTransaction} from './credit-note-history-prototype.js';
import {JournalConflict} from './journal-store.js';
import {readSaleCashPreview} from './sale-cash-preview-prototype.js';
import {readJournalCashReconciliation} from './journal-cash-reconciliation-prototype.js';

export class ClosureConflict extends Error {}
export class ClosureProofConflict extends ClosureConflict {}
export class ClosureAbandoned extends ClosureConflict {}
const identifier=z.string().uuid();
const proofSchema=z.array(z.object({noteOperationId:identifier,assignmentId:identifier,refund:z.number().int().safe().positive()}).strict()).max(10000).superRefine((items,ctx)=>{for(let i=1;i<items.length;i++)if(items[i-1].noteOperationId>=items[i].noteOperationId)ctx.addIssue({code:'custom',message:'Preuve de remboursements non triée ou dupliquée.'});});
function checkInputs(commercialId:string,day:string) {identifier.parse(commercialId);journalDateSchema.parse(day);}
function fromRow(commercialId:string,day:string,row: {status:'open'|'closed';version:number;closed_at:Date|string|null}|undefined):TourClosureState {
 if(!row) return initialTourClosure(commercialId,day);
 return {commercialId,day,status:row.status,version:row.version,closedAt:row.closed_at ? new Date(row.closed_at).toISOString():null};
}
/** Verrou unique par commercial et jour. À prendre dans la même transaction que toute écriture future. */
export async function lockTourClosure(db:PoolClient,commercialId:string,day:string):Promise<TourClosureState> {
 checkInputs(commercialId,day);
 // L'insertion concurrente sur la clé unique attend l'autre transaction même pour la première écriture.
 await db.query(`INSERT INTO tour_closures(commercial_id,journal_date,status,version) VALUES($1,$2::date,'open',0)
 ON CONFLICT(commercial_id,journal_date) DO NOTHING`,[commercialId,day]);
 const result=await db.query('SELECT status,version,closed_at FROM tour_closures WHERE commercial_id=$1 AND journal_date=$2::date FOR UPDATE',[commercialId,day]);
 return fromRow(commercialId,day,result.rows[0]);
}
export async function readTourClosure(pool:Pool,commercialId:string,day:string):Promise<TourClosureState> {
 checkInputs(commercialId,day);
 const result=await pool.query('SELECT status,version,closed_at FROM tour_closures WHERE commercial_id=$1 AND journal_date=$2::date',[commercialId,day]);
 return fromRow(commercialId,day,result.rows[0]);
}
/** L'acteur DOIT provenir de l'authentification serveur, jamais de la requête mobile. */
export async function changeTourClosure(pool:Pool,commercialId:string,day:string,action:'close'|'reopen',actor:TourActor,expectedVersion:number):Promise<TourClosureState> {
 checkInputs(commercialId,day);
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  const commercial=await db.query('SELECT id FROM commercials WHERE id=$1 AND deleted_at IS NULL',[commercialId]);
  if(!commercial.rows.length) throw new ClosureConflict('Commercial introuvable.');
  const state=await lockTourClosure(db,commercialId,day);
  let next;
  try {next=transitionTourClosure(state,action,actor,new Date().toISOString(),expectedVersion);}
  catch(error) {if(error instanceof RangeError) throw new ClosureConflict(error.message);throw error;}
  if(next.state.version>2147483647) throw new ClosureConflict('Trop de changements de clôture.');
  await db.query('UPDATE tour_closures SET status=$3,version=$4,closed_at=$5 WHERE commercial_id=$1 AND journal_date=$2::date',[commercialId,day,next.state.status,next.state.version,next.state.closedAt]);
  await db.query(`INSERT INTO tour_closure_events(id,commercial_id,journal_date,action,actor_id,actor_role,occurred_at,version)
   VALUES($1,$2,$3::date,$4,$5,$6,$7,$8)`,[randomUUID(),commercialId,day,action,actor.id,actor.role,next.event.at,next.event.version]);
  await db.query('COMMIT');return next.state;
 } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}

/** Service expérimental uniquement : une session commerciale ne peut clôturer que sa propre journée.
 * L'admin est fourni uniquement par un middleware serveur, jamais par le corps de la requête. */
export async function requestTourTransition(pool:Pool, input:{requestId:string;day:string;expectedVersion:number;adminRefundProof?:{noteOperationId:string;assignmentId:string;refund:number}[];cashProof?:string}, principal:
 {kind:'commercial';token:string;secret:string}|{kind:'admin';actorId:string;commercialId:string}, enforceMode=false, creditAware=false, requireCreditClose=false) {
 const {requestId,day,expectedVersion,adminRefundProof,cashProof}=z.object({requestId:identifier,day:journalDateSchema,expectedVersion:z.number().int().min(0).max(2147483646),adminRefundProof:proofSchema.optional(),cashProof:z.string().regex(/^[0-9a-f]{64}$/).optional()}).strict().parse(input);
 if((adminRefundProof!==undefined||cashProof!==undefined)&&(!creditAware||principal.kind!=='commercial'))throw new ClosureConflict('Preuve de caisse non autorisée.');
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  if(enforceMode) assertIdentifiedMode(await lockSyncMode(db));
  let commercialId:string,actor:TourActor,action:'close'|'reopen';
  if(principal.kind==='commercial') {
   // La vérification et le verrou de compte sont dans la même transaction que la transition.
   const {verifyCommercialSession}=await import('./commercial-session.js');
   const commercial=await verifyCommercialSession(db,principal.secret,principal.token,true);
   if(!commercial) throw new ClosureAuthenticationError('Session commerciale invalide ou expirée.');
   commercialId=commercial.id;actor={id:commercialId,role:'commercial'};action='close';
  } else {
   commercialId=identifier.parse(principal.commercialId);
   if(!principal.actorId || !principal.actorId.trim()) throw new ClosureAuthenticationError('Administrateur requis.');
   actor={id:principal.actorId,role:'admin'};action='reopen';
   const commercial=await db.query('SELECT id FROM commercials WHERE id=$1 AND deleted_at IS NULL',[commercialId]);
   if(!commercial.rows.length) throw new ClosureConflict('Commercial introuvable.');
  }
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['tour-closure-request',requestId]);
  const existing=await db.query(`SELECT commercial_id,journal_date::text AS day,action,actor_id,actor_role,expected_version,result_version,occurred_at,admin_refund_proof,cash_proof
   FROM tour_closure_requests WHERE request_id=$1`,[requestId]);
  if(existing.rows.length) {
   const old=existing.rows[0];
   if(old.commercial_id!==commercialId || old.day!==day || old.action!==action || old.actor_id!==actor.id || old.actor_role!==actor.role || old.expected_version!==expectedVersion || canonicalJson(old.admin_refund_proof??null)!==canonicalJson(adminRefundProof??null) || (old.cash_proof??null)!==(cashProof??null)) throw new ClosureConflict('Identifiant de demande déjà utilisé.');
   await db.query('COMMIT');return {status:'duplicate' as const,requestId,commercialId,day,action,version:old.result_version,at:new Date(old.occurred_at).toISOString()};
  }
  const abandoned=await db.query('SELECT request_id FROM tour_close_abandoned_requests WHERE request_id=$1',[requestId]);
  if(abandoned.rows.length)throw new ClosureAbandoned('Demande de clôture abandonnée : synchronisez et préparez une nouvelle demande.');
  if(requireCreditClose&&action==='close'&&!creditAware)throw new ClosureConflict('Clôture v5 requise : mettez à jour le téléphone et synchronisez.');
  if(enforceMode&&!creditAware)await assertOldCreditProtocolSafe(db);
  const state=await lockTourClosure(db,commercialId,day);
  // Les écritures de vente prennent ce même verrou avant insertion ; une
  // clôture ne peut donc pas dépasser un remboursement reçu simultanément.
  if(creditAware&&action==='close'){
   await assertSaleRefundJournalSafe(db,commercialId,day);
   // Un avoir saisi par l'administrateur ne dit pas quelle caisse a payé.
   // Bloquer plutôt que clôturer un montant commercial considéré à tort complet.
   let history:Awaited<ReturnType<typeof readPrototypeCreditHistoryInTransaction>>;
   try{history=await readPrototypeCreditHistoryInTransaction(db);}catch(e){if(e instanceof RangeError)throw new JournalConflict('Historique d’avoirs incohérent : clôture refusée.');throw e;}
   if(history.some(h=>h.recordedDay===day&&h.actor.role==='admin'&&h.refund>0&&!h.cashAssignment))throw new JournalConflict('Remboursement d’avoir saisi par l’administrateur : caisse non attribuée, clôture refusée.');
   // Les avoirs créés ailleurs ne sont pas encore déduits du facturé sur le
   // téléphone propriétaire. Refuser une clôture qui le présenterait complet.
   if(history.some(h=>h.ownerId===commercialId&&h.recordedDay===day&&(h.actor.role!=='commercial'||h.actor.id!==commercialId)))throw new JournalConflict('Avoir créé ailleurs sur une facture de ce commercial : rapprochement du facturé requis avant clôture.');
   // La liste a été figée avec le journal du téléphone. Le verrou global de
   // mode empêche qu'une attribution ou un avoir passe entre ce contrôle et
   // la clôture ; une liste absente ou périmée ne lève jamais la garde.
   const expected=history.filter(h=>h.recordedDay===day&&h.actor.role==='admin'&&h.refund>0&&h.cashAssignment?.commercialId===commercialId)
    .map(h=>({noteOperationId:h.operationId,assignmentId:h.cashAssignment!.requestId,refund:h.refund})).sort((a,b)=>a.noteOperationId<b.noteOperationId?-1:a.noteOperationId>b.noteOperationId?1:0);
   if((expected.length>0||adminRefundProof!==undefined)&&canonicalJson(adminRefundProof??null)!==canonicalJson(expected))throw new ClosureProofConflict('Remboursement administrateur attribué à ce commercial : rapprochement du téléphone requis avant clôture.');
   if(!cashProof)throw new ClosureProofConflict('Preuve de caisse complète absente : mettez à jour et synchronisez le téléphone avant clôture.');
   // Toutes les écritures pertinentes sont sérialisées par le verrou de mode
   // et celui de la journée, conservés jusqu'au commit. Recalculer les flux
   // depuis les événements reçus, jamais depuis les totaux fournis par le client.
   let canonical:string;
   try{
    const sale=await readSaleCashPreview(db,commercialId,day);if(!sale.available)throw new ClosureProofConflict(`Rapprochement des ventes impossible : ${sale.reason}`);
    const sales={version:5 as const,commercialId,day,initialEvents:sale.initialEvents,refundEvents:sale.refundEvents.map(({operationId,saleId,clientId,recordedAt,refund})=>({operationId,saleId,clientId,recordedAt,refund})),saleStates:sale.entries.filter(e=>sale.initialEvents.some(p=>p.saleId===e.saleId)).map(({saleId,clientId,version,total,paid})=>({saleId,clientId,version,total,paid}))};
    const journal=await readJournalCashReconciliation(db,commercialId,day);
    canonical=cashClosureCanonical(sales,journal,commercialId,day);
   }catch(error){if(error instanceof ClosureConflict||error instanceof JournalConflict)throw error;if(error instanceof RangeError||error instanceof z.ZodError)throw new ClosureProofConflict('Historique de caisse incohérent ou incomplet : clôture refusée.');throw error;}
   if(createHash('sha256').update(canonical).digest('hex')!==cashProof)throw new ClosureProofConflict('Caisse différente entre téléphone et serveur : comparez les opérations et synchronisez avant clôture.');
  }
  let next;
  try {next=transitionTourClosure(state,action,actor,new Date().toISOString(),expectedVersion);}
  catch(error) {if(error instanceof RangeError) throw new ClosureConflict(error.message);throw error;}
  await db.query('UPDATE tour_closures SET status=$3,version=$4,closed_at=$5 WHERE commercial_id=$1 AND journal_date=$2::date',[commercialId,day,next.state.status,next.state.version,next.state.closedAt]);
  await db.query(`INSERT INTO tour_closure_events(id,commercial_id,journal_date,action,actor_id,actor_role,occurred_at,version)
   VALUES($1,$2,$3::date,$4,$5,$6,$7,$8)`,[randomUUID(),commercialId,day,action,actor.id,actor.role,next.event.at,next.event.version]);
  await db.query(`INSERT INTO tour_closure_requests(request_id,commercial_id,journal_date,action,actor_id,actor_role,expected_version,result_version,occurred_at,admin_refund_proof,cash_proof)
   VALUES($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,[requestId,commercialId,day,action,actor.id,actor.role,expectedVersion,next.event.version,next.event.at,adminRefundProof===undefined?null:JSON.stringify(adminRefundProof),cashProof??null]);
  await db.query('COMMIT');return {status:'received' as const,requestId,commercialId,day,action,version:next.event.version,at:next.event.at};
 } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
export class ClosureAuthenticationError extends Error {}

/** Réserve définitivement l'UUID avant d'autoriser le téléphone à oublier
 * une tentative incertaine ; une clôture arrivée en parallèle gagne ou perd
 * le même verrou. La réponse perdue peut être redemandée sans risque. */
export async function abandonTourClose(pool:Pool,input:{requestId:string;day:string;expectedVersion:number},principal:{token:string;secret:string}) {
 const {requestId,day,expectedVersion}=z.object({requestId:identifier,day:journalDateSchema,expectedVersion:z.number().int().min(0).max(2147483646)}).strict().parse(input);
 const db=await pool.connect();try{
  await db.query('BEGIN');assertIdentifiedMode(await lockSyncMode(db));
  const {verifyCommercialSession}=await import('./commercial-session.js');const actor=await verifyCommercialSession(db,principal.secret,principal.token,true);
  if(!actor)throw new ClosureAuthenticationError('Session commerciale invalide ou expirée.');
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['tour-closure-request',requestId]);
  const existing=await db.query('SELECT commercial_id,journal_date::text AS day,action,expected_version FROM tour_closure_requests WHERE request_id=$1',[requestId]);
  if(existing.rows.length){const r=existing.rows[0];if(r.commercial_id!==actor.id||r.day!==day||r.action!=='close'||r.expected_version!==expectedVersion)throw new ClosureConflict('Identifiant de demande déjà utilisé.');await db.query('COMMIT');return {status:'already-received' as const,requestId,commercialId:actor.id,day,expectedVersion};}
  const abandoned=await db.query('SELECT commercial_id,journal_date::text AS day,expected_version FROM tour_close_abandoned_requests WHERE request_id=$1',[requestId]);
  if(abandoned.rows.length){const r=abandoned.rows[0];if(r.commercial_id!==actor.id||r.day!==day||r.expected_version!==expectedVersion)throw new ClosureConflict('Identifiant de demande déjà utilisé.');}
  else await db.query('INSERT INTO tour_close_abandoned_requests(request_id,commercial_id,journal_date,expected_version) VALUES($1,$2,$3::date,$4)',[requestId,actor.id,day,expectedVersion]);
  await db.query('COMMIT');return {status:'abandoned' as const,requestId,commercialId:actor.id,day,expectedVersion};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
