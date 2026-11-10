/** Résolution expérimentale, réservée au protocole v5 non activé. Le verrou
 * UUID est partagé avec la réception des ventes et des autres opérations. */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {saleEventSchema} from './identified-operations.js';
import {verifyCommercialSession} from './commercial-session.js';
import {assertIdentifiedMode,lockSyncMode} from './tour-sync-mode.js';
import {lockIdentifiedOperation,assertOperationUnambiguous} from './identified-overlap.js';
import {assertCreditOperationAvailable} from './credit-note-active-guards.js';
import {JournalAuthenticationError,JournalConflict} from './journal-store.js';
/** Réserve irrévocablement l'UUID d'une révision non reçue ; une requête déjà
 * reçue ne peut pas être annulée ainsi. Les reprises sont idempotentes. */
export async function abandonRemoteSalePrototype(pool:Pool,input:unknown,session:{secret:string;token:string}){
 const event=saleEventSchema.parse(input);
 if(event.version<2||event.sale.syncSaleId!==event.saleId||event.sale.syncVersion!==event.version)throw new RangeError('Révision distante invalide.');
 const payload=JSON.stringify(event),hash=createHash('sha256').update(payload).digest('hex'),db=await pool.connect();
 try{
  await db.query('BEGIN');assertIdentifiedMode(await lockSyncMode(db));
  const actor=await verifyCommercialSession(db,session.secret,session.token,true);if(!actor)throw new JournalAuthenticationError('Session invalide ou expirée.');
  await lockIdentifiedOperation(db,event.operationId);
  const old=await db.query('SELECT commercial_id,payload_hash,sale_id,version FROM remote_sale_abandon_prototype WHERE operation_id=$1',[event.operationId]);
  if(old.rows.length){const row=old.rows[0];if(row.commercial_id!==actor.id||row.payload_hash!==hash||row.sale_id!==event.saleId||row.version!==event.version)throw new JournalConflict('Identifiant de révision déjà utilisé.');await db.query('COMMIT');return {status:'abandoned' as const,operationId:event.operationId,saleId:event.saleId,version:event.version};}
  await assertCreditOperationAvailable(db,event.operationId);await assertOperationUnambiguous(db,event.operationId,'sale');
  const stored=await db.query('SELECT commercial_id,payload_hash,sale_id,version FROM identified_sale_events WHERE operation_id=$1',[event.operationId]);
  if(stored.rows.length){const row=stored.rows[0];if(row.commercial_id!==actor.id||row.payload_hash!==hash||row.sale_id!==event.saleId||row.version!==event.version)throw new JournalConflict('Identifiant de révision déjà utilisé.');await db.query('COMMIT');return {status:'already-received' as const,operationId:event.operationId,saleId:event.saleId,version:event.version};}
  const original=await db.query('SELECT payload FROM identified_sale_events WHERE sale_id=$1 AND version=1',[event.saleId]);
  if(original.rows.length!==1||original.rows[0].payload?.sale?.clientId!==event.sale.clientId)throw new JournalConflict('Facture distante introuvable ou client différent.');
  await db.query('INSERT INTO remote_sale_abandon_prototype(operation_id,sale_id,version,commercial_id,payload,payload_hash) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[event.operationId,event.saleId,event.version,actor.id,payload,hash]);
  await db.query('COMMIT');return {status:'abandoned' as const,operationId:event.operationId,saleId:event.saleId,version:event.version};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
