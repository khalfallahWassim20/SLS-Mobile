/** Remise effective d'un remboursement d'avoir. Un avoir qui choisit « remboursement »
 * ne prouve pas que l'argent a été remis : cet enregistrement, unique et définitif,
 * le prouve (montant, date, auteur, bénéficiaire, justificatif). Il ne modifie ni les
 * soldes, ni le journal, ni la clôture. Le type de justificatif est à valider avec le comptable. */
import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import {assertIdentifiedMode,lockSyncModeExclusive} from './tour-sync-mode.js';
import {readPrototypeCreditHistoryInTransaction} from './credit-note-history-prototype.js';
import {verifyCommercialSession} from './commercial-session.js';
import {JournalAuthenticationError,JournalConflict} from './journal-store.js';
const uuid=z.string().uuid();
export const refundHandoverSchema=z.object({requestId:uuid,noteOperationId:uuid,amount:z.number().int().safe().positive(),handedAt:z.string().datetime(),
 proofKind:z.enum(['signature','recu_papier','virement','autre']),proofReference:z.string().trim().min(1).max(200)}).strict();
export type RefundHandoverPrincipal={kind:'commercial';secret:string;token:string}|{kind:'admin';actorId:string};
type NoteRecord={operationId:string;clientId:string;ownerId:string;recordedAt:string;refund:number;actor:{id:string;role:'commercial'|'admin'};cashAssignment:{commercialId:string|null}|null};
type Deps={now?:()=>Date;readHistory?:(db:PoolClient)=>Promise<NoteRecord[]>};
const FUTURE_TOLERANCE_MS=5*60*1000;
export async function recordCreditRefundHandover(pool:Pool,raw:unknown,principal:RefundHandoverPrincipal,deps:Deps={}){
 const command=refundHandoverSchema.parse(raw),now=(deps.now??(()=>new Date()))(),db=await pool.connect();
 try{
  await db.query('BEGIN');assertIdentifiedMode(await lockSyncModeExclusive(db));
  let by:{kind:'commercial'|'admin';id:string};
  if(principal.kind==='commercial'){
   const commercial=await verifyCommercialSession(db,principal.secret,principal.token,true);
   if(!commercial)throw new JournalAuthenticationError('Session commerciale invalide ou expirée.');
   by={kind:'commercial',id:commercial.id};
  }else{
   if(typeof principal.actorId!=='string'||!principal.actorId.trim()||principal.actorId.length>200)throw new JournalAuthenticationError('Administrateur requis.');
   by={kind:'admin',id:principal.actorId};
  }
  const history=await (deps.readHistory??(h=>readPrototypeCreditHistoryInTransaction(h) as unknown as Promise<NoteRecord[]>))(db);
  const note=history.find(h=>h.operationId===command.noteOperationId);
  if(!note)throw new JournalConflict('Avoir introuvable : actualisez le journal.');
  if(!(note.refund>0))throw new JournalConflict('Cet avoir ne comporte aucun remboursement à remettre.');
  if(command.amount!==note.refund)throw new JournalConflict('Le montant remis doit être égal au remboursement de l’avoir.');
  // Qui peut confirmer la remise : le commercial concerné, ou l'administrateur.
  if(by.kind==='commercial'){
   const allowed=note.actor.role==='commercial'?note.ownerId:note.cashAssignment?.commercialId??null;
   if(allowed===null||allowed.toLowerCase()!==by.id.toLowerCase())throw new JournalConflict('Seul le commercial concerné par ce remboursement, ou l’administrateur, peut confirmer sa remise.');
  }
  const handed=new Date(command.handedAt);
  if(handed.getTime()>now.getTime()+FUTURE_TOLERANCE_MS)throw new JournalConflict('La date de remise ne peut pas être dans le futur.');
  if(handed.getTime()<new Date(note.recordedAt).getTime())throw new JournalConflict('La remise ne peut pas précéder l’avoir.');
  const old=await db.query(`SELECT note_operation_id,request_id,amount::text AS amount,handed_at,proof_kind,proof_reference,recorded_by_kind,recorded_by_id,recorded_at FROM credit_refund_handover WHERE note_operation_id=$1 OR request_id=$2`,[command.noteOperationId,command.requestId]);
  if(old.rows.length){
   const r=old.rows[0];
   const same=old.rows.length===1&&r.request_id===command.requestId&&r.note_operation_id===command.noteOperationId&&r.amount===String(command.amount)&&new Date(r.handed_at).getTime()===handed.getTime()&&r.proof_kind===command.proofKind&&r.proof_reference===command.proofReference&&r.recorded_by_kind===by.kind&&r.recorded_by_id===by.id;
   if(!same)throw new JournalConflict('La remise de ce remboursement est déjà enregistrée avec des données différentes.');
   await db.query('COMMIT');return {status:'duplicate' as const,...command,beneficiaryClientId:note.clientId,recordedAt:new Date(r.recorded_at).toISOString()};
  }
  const inserted=await db.query(`INSERT INTO credit_refund_handover(note_operation_id,request_id,beneficiary_client_id,amount,handed_at,proof_kind,proof_reference,recorded_by_kind,recorded_by_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING recorded_at`,
   [command.noteOperationId,command.requestId,note.clientId,command.amount,command.handedAt,command.proofKind,command.proofReference,by.kind,by.id]);
  await db.query('COMMIT');
  return {status:'received' as const,...command,beneficiaryClientId:note.clientId,recordedAt:new Date(inserted.rows[0].recorded_at).toISOString()};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
