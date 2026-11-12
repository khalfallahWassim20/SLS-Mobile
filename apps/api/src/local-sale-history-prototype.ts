/** Historique vérifiable d'une vente locale pour rapprochement v5, non activé. */
import {createHash} from 'node:crypto';
import {canonicalJson} from '@sls/domain';
import type {Pool} from 'pg';
import {z} from 'zod';
import {saleEventSchema} from './identified-operations.js';
import {verifyCommercialSession} from './commercial-session.js';
import {JournalAuthenticationError,JournalConflict} from './journal-store.js';
import {assertIdentifiedMode,lockSyncMode} from './tour-sync-mode.js';
import {readPrototypeCreditReferenceInTransaction} from './credit-note-reference-prototype.js';

/** L'identité du créateur et tous les événements proviennent du même instantané.
 * Ne renvoie aucun historique partiel, ni aucun prix d'achat. */
export async function readLocalSaleHistoryPrototype(pool:Pool,saleId:string,session:{secret:string;token:string},testGuard?:()=>Promise<void>){
 z.string().uuid().parse(saleId);const db=await pool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));
  const actor=await verifyCommercialSession(db,session.secret,session.token);if(!actor)throw new JournalAuthenticationError('Session invalide ou expirée.');
  const rows=await db.query('SELECT operation_id,sale_id,version,client_id,commercial_id,payload,payload_hash FROM identified_sale_events WHERE sale_id=$1 ORDER BY version LIMIT 201',[saleId]);
  if(!rows.rows.length||rows.rows[0].commercial_id!==actor.id){await db.query('COMMIT');return null;}
  if(rows.rows.length>200)throw new JournalConflict('Historique trop long : rapprochement manuel nécessaire.');
  if((await db.query('SELECT 1 FROM demo_sale_events WHERE sale_id=$1 LIMIT 1',[saleId])).rows.length)throw new JournalConflict('Ancienne vente : rapprochement manuel nécessaire.');
  const events=[];
  for(const [i,row] of rows.rows.entries()){
   const event=saleEventSchema.parse(row.payload),hash=createHash('sha256').update(JSON.stringify(event)).digest('hex');
   if(row.version!==i+1||row.operation_id!==event.operationId||row.sale_id!==saleId||event.saleId!==saleId||event.version!==row.version||event.sale.syncSaleId!==saleId||event.sale.syncVersion!==event.version||row.client_id!==event.sale.clientId||row.client_id!==rows.rows[0].client_id||row.payload_hash!==hash)throw new JournalConflict('Historique de vente incohérent.');
   events.push({commercialId:row.commercial_id as string,event});
  }
  if(testGuard)await testGuard();
  const reference=await readPrototypeCreditReferenceInTransaction(db),state=reference.saleStates.find(s=>s.saleId===saleId),last=events[events.length-1].event;
  const proof=state?.creditNote?reference.saleProofs.find(p=>p.saleId===saleId):reference.eligibleSaleProofs.find(p=>p.saleId===saleId);
  if(!state||state.clientId!==last.sale.clientId||!proof||proof.version!==last.version||(state.creditNote?state.creditNote.command.expectedVersion!==last.version:state.version!==last.version)||proof.hash!==createHash('sha256').update(canonicalJson(last.sale)).digest('hex'))throw new JournalConflict('Preuve de vente indisponible ou incohérente.');
  await db.query('COMMIT');return {ownerId:actor.id as string,saleId,clientId:last.sale.clientId,events,reference};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
