/** Lecture administrative v5 isolée : ne pas monter dans le serveur courant
 * avant la migration de toutes les écritures, soldes et interfaces. */
import type {Pool} from 'pg';
import {z} from 'zod';
import {assertIdentifiedMode,lockSyncMode} from './tour-sync-mode.js';
import {readPrototypeCreditReferenceInTransaction} from './credit-note-reference-prototype.js';

/** Soldes et ventes sont construits depuis le même instantané. Les factures
 * originales restent consultables ; une annulation est explicite, jamais
 * présentée comme une vente normale ni déduite deux fois du solde. */
export async function readPrototypeAdminCreditSnapshot(pool:Pool) {
 const db=await pool.connect();
 try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  assertIdentifiedMode(await lockSyncMode(db));
  const reference=await readPrototypeCreditReferenceInTransaction(db);
  const rows=await db.query(`SELECT DISTINCT ON (sale_id) sale_id AS "saleId",version,client_id AS "clientId",payload->'sale' AS sale,received_at AS "receivedAt"
   FROM (SELECT sale_id,version,client_id,payload,received_at FROM demo_sale_events UNION ALL
    SELECT sale_id,version,client_id,payload,received_at FROM identified_sale_events) s
   ORDER BY sale_id,version DESC`);
  const states=new Map(reference.saleStates.map(s=>[s.saleId,s]));
  const clients=new Set(reference.clients.map(c=>c.id));
  const sales=rows.rows.map(row=>{
   const state=states.get(row.saleId),sale=row.sale;
   if(!state||!clients.has(row.clientId)||state.clientId!==row.clientId||!sale||sale.clientId!==row.clientId||sale.syncSaleId!==row.saleId||sale.syncVersion!==row.version||state.version!==row.version+(state.cancelled?1:0))throw new RangeError('Vente administrative incohérente.');
   if(!state.cancelled&&(String(sale.total)!==state.total||String(sale.paid)!==state.paid))throw new RangeError('Totaux de vente administrative incohérents.');
   return {saleId:row.saleId,version:row.version,sale,receivedAt:row.receivedAt,cancelled:state.cancelled,creditNote:state.creditNote};
  });
  if(sales.length!==states.size)throw new RangeError('Ventes administratives incomplètes.');
  const balances=reference.clients.map(c=>({id:c.id,name:c.name,openingBalance:c.openingBalance,creditLimit:c.creditLimit,balance:c.serverBalance,active:c.active}));
  await db.query('COMMIT');return {version:5 as const,balances,sales};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

/** Historique de la facture d'origine, au même instant que son marqueur
 * d'annulation. Une facture ancienne non identifiée reste consultable mais ne
 * devient pas automatiquement admissible à un avoir. */
export async function readPrototypeAdminCreditSaleHistory(pool:Pool,saleId:string) {
 z.string().uuid().parse(saleId);
 const db=await pool.connect();
 try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));
  const reference=await readPrototypeCreditReferenceInTransaction(db);
  const state=reference.saleStates.find(s=>s.saleId===saleId);
  const events=await db.query(`SELECT * FROM (
   SELECT e.operation_id AS "operationId",e.version,e.payload,e.received_at AS "receivedAt",NULL::uuid AS "commercialId",NULL::text AS "commercialName",'ancien' AS source FROM demo_sale_events e WHERE e.sale_id=$1
   UNION ALL SELECT e.operation_id AS "operationId",e.version,e.payload,e.received_at AS "receivedAt",e.commercial_id AS "commercialId",c.name AS "commercialName",'identifié' AS source FROM identified_sale_events e LEFT JOIN commercials c ON c.id=e.commercial_id WHERE e.sale_id=$1
  ) history ORDER BY version DESC,"receivedAt" DESC,"operationId" DESC LIMIT 201`,[saleId]);
  if(!events.rows.length){if(state)throw new RangeError('Historique de vente incohérent.');await db.query('COMMIT');return null;}
  const latest=events.rows[0],sale=latest.payload?.sale;
  if(!state||!sale||sale.syncSaleId!==saleId||sale.syncVersion!==latest.version||state.clientId!==sale.clientId||state.version!==latest.version+(state.cancelled?1:0))throw new RangeError('Historique de vente incohérent.');
  const versions=events.rows.slice(0,200).map(e=>({operationId:e.operationId,version:e.version,sale:e.payload.sale,refund:e.payload.refund,recordedAt:e.source==='identifié'?e.payload.recordedAt:null,receivedAt:e.receivedAt,commercialId:e.commercialId,commercialName:e.commercialName,source:e.source}));
  await db.query('COMMIT');return {version:5 as const,saleId,truncated:events.rows.length>200,versions,cancelled:state.cancelled,creditNote:state.creditNote};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
