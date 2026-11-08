/** Consultation administrative, limitée aux versions effectivement reçues. */
import {Router} from 'express';
import type {Pool} from 'pg';
import {z} from 'zod';
import {assertOldCreditProtocolSafe} from './credit-note-active-guards.js';

export function saleHistoryRoutes(pool:Pool) {
 const r=Router();
 r.get('/:saleId/history',async(req,res,next)=>{
  const id=z.string().uuid().safeParse(req.params.saleId);
  if(!id.success){res.status(400).json({error:'Identifiant de vente invalide.'});return;}
  const db=await pool.connect();
  try {
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const mode=(await db.query('SELECT mode FROM tour_sync_mode WHERE id=1')).rows[0]?.mode;
   if(mode!=='legacy'&&mode!=='identified')throw Error('Mode de synchronisation indisponible.');
   if(mode==='identified')await assertOldCreditProtocolSafe(db);
   const events=await db.query(`SELECT * FROM (
    SELECT e.operation_id AS "operationId",e.version,e.payload,e.received_at AS "receivedAt",NULL::uuid AS "commercialId",NULL::text AS "commercialName",'ancien' AS source
    FROM demo_sale_events e WHERE e.sale_id=$1
    ${mode==='identified'?`UNION ALL SELECT e.operation_id AS "operationId",e.version,e.payload,e.received_at AS "receivedAt",e.commercial_id AS "commercialId",c.name AS "commercialName",'identifié' AS source
    FROM identified_sale_events e LEFT JOIN commercials c ON c.id=e.commercial_id WHERE e.sale_id=$1`:''}
   ) history ORDER BY version DESC,"receivedAt" DESC,"operationId" DESC LIMIT 201`,[id.data]);
   await db.query('COMMIT');
   if(!events.rows.length){res.status(404).json({error:'Vente introuvable parmi les données reçues.'});return;}
   res.set('Cache-Control','no-store').json({saleId:id.data,truncated:events.rows.length>200,versions:events.rows.slice(0,200).map(e=>({operationId:e.operationId,version:e.version,sale:e.payload.sale,refund:e.payload.refund,recordedAt:e.source==='identifié'?e.payload.recordedAt:null,receivedAt:e.receivedAt,commercialId:e.commercialId,commercialName:e.commercialName,source:e.source}))});
  } catch(error){await db.query('ROLLBACK');next(error);}finally{db.release();}
 });
 return r;
}
