/** Prototype non exposé par les routes. Une autorisation administrative est
 * une attestation humaine, PAS une preuve de continuité de l'ancienne base.
 * Son intégration doit exiger HTTPS authentifié de bout en bout. */
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {Pool} from 'pg';
import {isPrivateHttpOrigin} from '../../mobile/private-api-origin.js';
import {verifyCommercialSession} from './commercial-session.js';

const origin=z.string().max(2048).refine(value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash&&u.origin===value&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname);}catch{return false;}},'Origine invalide.');
const hash=(code:string)=>createHash('sha256').update(code,'utf8').digest('hex');
export class AddressApprovalRejected extends Error {constructor(){super('Autorisation indisponible, expirée ou incohérente.');}}

/** L'identité admin doit provenir de son middleware de session, jamais du corps.
 * Les détails sont liés au code aléatoire ; ni mot de passe ni code en clair
 * ne sont conservés. Répéter la création avec le même UUID est refusé. */
export async function issueAddressApproval(pool:Pool,admin:string,input:unknown,allowPrivateHttp=false){
 if(!admin||!admin.trim()||admin.length>200)throw new RangeError('Administrateur requis.');
 // Éviter que des champs inattendus soient acceptés par les intersections Zod.
 const body=z.object({requestId:z.string().uuid(),commercialId:z.string().uuid(),previousOrigin:origin,targetOrigin:origin.refine(v=>v.startsWith('https://')||(allowPrivateHttp&&isPrivateHttpOrigin(v))),lineageId:z.string().uuid(),confirmation:z.literal('J_AI_VERIFIE_LA_BASE_ET_LE_TELEPHONE')}).strict().parse(input);
 const parsed=body;if(parsed.previousOrigin===parsed.targetOrigin)throw new RangeError('Adresses identiques.');
 const code=randomBytes(32).toString('base64url'),db=await pool.connect();
 try{
  await db.query('BEGIN');
  const commercial=await db.query('SELECT name FROM commercials WHERE id=$1 AND active AND deleted_at IS NULL FOR SHARE',[parsed.commercialId]);
  const lineage=await db.query('SELECT lineage_id::text AS id FROM server_lineage_identity WHERE id=1');
  if(!commercial.rows.length||lineage.rows[0]?.id!==parsed.lineageId)throw new AddressApprovalRejected();
  const result=await db.query(`INSERT INTO mobile_address_approvals(request_id,commercial_id,previous_origin,target_origin,lineage_id,code_hash,approved_by,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '5 minutes') ON CONFLICT(request_id) DO NOTHING RETURNING expires_at`,[parsed.requestId,parsed.commercialId,parsed.previousOrigin,parsed.targetOrigin,parsed.lineageId,hash(code),admin]);
  if(!result.rows.length)throw new AddressApprovalRejected();
  await db.query('INSERT INTO audit_log(id,actor,action,entity,entity_id,entity_name,changed_fields) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),admin,'autorisation changement adresse','mobile_address_approvals',parsed.requestId,commercial.rows[0].name,['commercial','ancienne adresse','nouvelle adresse','lignée']]);
  await db.query('COMMIT');return {requestId:parsed.requestId,code,expiresAt:new Date(result.rows[0].expires_at).toISOString()};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
/** Reprise idempotente jusqu'à expiration uniquement avec le même code et la
 * même session. Aucune preuve ne doit être considérée après expiration. */
export async function redeemAddressApproval(pool:Pool,secret:string,token:string,input:unknown,allowPrivateHttp=false){
 const body=z.object({requestId:z.string().uuid(),commercialId:z.string().uuid(),previousOrigin:origin,targetOrigin:origin.refine(v=>v.startsWith('https://')||(allowPrivateHttp&&isPrivateHttpOrigin(v))),lineageId:z.string().uuid(),code:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict().parse(input);
 const parsed=body,db=await pool.connect();
 try{
  await db.query('BEGIN');
  const actor=await verifyCommercialSession(db,secret,token,true);
  if(!actor||actor.id!==parsed.commercialId)throw new AddressApprovalRejected();
  const result=await db.query(`SELECT *,now()<expires_at AS valid, (SELECT lineage_id FROM server_lineage_identity WHERE id=1)::text AS actual_lineage
   FROM mobile_address_approvals WHERE request_id=$1 FOR UPDATE`,[parsed.requestId]);
  const row=result.rows[0],supplied=Buffer.from(hash(parsed.code),'hex'),stored=Buffer.from(row?.code_hash??'','hex');
  if(!row||stored.length!==supplied.length||!timingSafeEqual(stored,supplied)||!row.valid||row.revoked_at||row.commercial_id!==actor.id||row.previous_origin!==parsed.previousOrigin||row.target_origin!==parsed.targetOrigin||row.lineage_id!==parsed.lineageId||row.actual_lineage!==parsed.lineageId)throw new AddressApprovalRejected();
  const replay=!!row.redeemed_at;
  if(!replay){
   await db.query('UPDATE mobile_address_approvals SET redeemed_at=now() WHERE request_id=$1',[parsed.requestId]);
   await db.query('INSERT INTO audit_log(id,actor,action,entity,entity_id,entity_name,changed_fields) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),actor.id,'autorisation présentée','mobile_address_approvals',parsed.requestId,actor.name,[]]);
  }
  await db.query('COMMIT');return {requestId:parsed.requestId,commercialId:actor.id,previousOrigin:parsed.previousOrigin,targetOrigin:parsed.targetOrigin,lineageId:parsed.lineageId,expiresAt:new Date(row.expires_at).toISOString(),replay};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
/** La révocation ne modifie jamais les données du téléphone. */
export async function revokeAddressApproval(pool:Pool,admin:string,requestId:string){
 if(!admin||!admin.trim()||admin.length>200)throw new RangeError('Administrateur requis.');z.string().uuid().parse(requestId);
 const db=await pool.connect();try{await db.query('BEGIN');
  const result=await db.query(`UPDATE mobile_address_approvals SET revoked_at=now() WHERE request_id=$1 AND revoked_at IS NULL RETURNING commercial_id`,[requestId]);
  if(result.rows.length)await db.query('INSERT INTO audit_log(id,actor,action,entity,entity_id,entity_name,changed_fields) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),admin,'autorisation révoquée','mobile_address_approvals',requestId,result.rows[0].commercial_id,[]]);
  await db.query('COMMIT');return {revoked:!!result.rows.length};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
