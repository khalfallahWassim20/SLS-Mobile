/** Preuve d'une révision reçue, avec référence du même instantané. Isolé v5. */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {saleEventSchema} from './identified-operations.js';
import {verifyCommercialSession} from './commercial-session.js';
import {JournalAuthenticationError,JournalConflict} from './journal-store.js';
import {assertIdentifiedMode,lockSyncMode} from './tour-sync-mode.js';
import {readPrototypeCreditReferenceInTransaction} from './credit-note-reference-prototype.js';

/** Une absence ne prouve pas qu'une requête en vol ne va pas arriver : elle ne
 * peut jamais être utilisée pour abandonner une opération. */
export async function readRemoteSaleReceiptPrototype(pool:Pool,operationId:string,session:{secret:string;token:string},testGuard?:()=>Promise<void>){
 z.string().uuid().parse(operationId);const db=await pool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));
  const actor=await verifyCommercialSession(db,session.secret,session.token);if(!actor)throw new JournalAuthenticationError('Session invalide ou expirée.');
  const result=await db.query('SELECT operation_id,sale_id,version,client_id,commercial_id,payload,payload_hash FROM identified_sale_events WHERE operation_id=$1 AND commercial_id=$2',[operationId,actor.id]);
  if(!result.rows.length){await db.query('COMMIT');return null;}
  const row=result.rows[0],event=saleEventSchema.parse(row.payload),hash=createHash('sha256').update(JSON.stringify(event)).digest('hex');
  if(row.operation_id!==event.operationId||row.sale_id!==event.saleId||row.version!==event.version||row.client_id!==event.sale.clientId||event.sale.syncSaleId!==event.saleId||event.sale.syncVersion!==event.version||row.payload_hash!==hash||event.version<2)throw new JournalConflict('Preuve de révision incohérente.');
  // Crochet utilisé uniquement par les tests de concurrence PostgreSQL.
  if(testGuard)await testGuard();
  const reference=await readPrototypeCreditReferenceInTransaction(db),state=reference.saleStates.find(s=>s.saleId===event.saleId);
  const latest=state?.creditNote?state.creditNote.command.expectedVersion:state?.version;
  if(!state||state.clientId!==event.sale.clientId||!latest||latest<event.version)throw new JournalConflict('Référence de révision incohérente.');
  // Une preuve historique ne suffit pas si la chaîne comporte un trou, un
  // ancien espace ou une autre attribution client. Tout est lu dans le même MVCC.
  const chain=await db.query(`SELECT count(*)::int AS n,min(version)::int AS first,max(version)::int AS last,
   count(*) FILTER (WHERE client_id<>$2)::int AS wrong_client FROM identified_sale_events WHERE sale_id=$1`,[event.saleId,event.sale.clientId]);
  const legacy=await db.query('SELECT 1 FROM demo_sale_events WHERE sale_id=$1 LIMIT 1',[event.saleId]);
  const c=chain.rows[0];if(!c||c.n!==latest||c.first!==1||c.last!==latest||c.wrong_client!==0||legacy.rows.length)throw new JournalConflict('Historique de vente incomplet ou incompatible.');
  await db.query('COMMIT');return {status:'received' as const,commercialId:actor.id as string,event,reference};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
