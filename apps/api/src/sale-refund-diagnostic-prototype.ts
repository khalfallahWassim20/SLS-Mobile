/** Diagnostic administrateur en lecture seule ; ne débloque aucun journal et
 * ne constitue ni rapprochement de caisse ni preuve de versement physique. */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import {journalDateSchema} from './journal-protocol.js';
import {saleEventSchema} from './identified-operations.js';
import {assertIdentifiedMode,lockSyncMode} from './tour-sync-mode.js';

export async function readSaleRefundDiagnostic(pool:Pool,commercialId:string,day:string){
 z.string().uuid().parse(commercialId);journalDateSchema.parse(day);
 const db=await pool.connect();try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));
  const commercial=await db.query('SELECT name FROM commercials WHERE id=$1 AND deleted_at IS NULL',[commercialId]);
  if(!commercial.rows.length)throw new RangeError('Commercial introuvable.');
  const closure=await db.query('SELECT status,version FROM tour_closures WHERE commercial_id=$1 AND journal_date=$2::date',[commercialId,day]);
  const result=await db.query(`SELECT r.operation_id AS "operationId",r.sale_id AS "saleId",r.version,r.client_id AS "clientId",r.payload,r.payload_hash AS hash,
   r.commercial_id AS "actorId",actor.name AS "actorName",r.event_date::text AS "refundDay",
   o.commercial_id AS "ownerId",owner.name AS "ownerName",o.journal_date::text AS "saleDay",
   p.payload AS previous,p.payload_hash AS "previousHash"
   FROM identified_sale_events r JOIN identified_sale_events o ON o.sale_id=r.sale_id AND o.version=1
   LEFT JOIN identified_sale_events p ON p.sale_id=r.sale_id AND p.version=r.version-1
   JOIN commercials actor ON actor.id=r.commercial_id JOIN commercials owner ON owner.id=o.commercial_id
   WHERE r.version>1 AND (r.payload->>'refund')::numeric>0
    AND (r.commercial_id<>o.commercial_id OR r.event_date IS DISTINCT FROM o.journal_date)
    AND ((o.commercial_id=$1 AND o.journal_date=$2::date) OR (r.commercial_id=$1 AND (r.event_date=$2::date OR r.event_date IS NULL)))
   ORDER BY r.event_date DESC NULLS FIRST,r.operation_id LIMIT 201`,[commercialId,day]);
  const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
  const tunisDay=(at:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
  const entries=result.rows.slice(0,200).map(row=>{
   const ep=saleEventSchema.safeParse(row.payload),pp=saleEventSchema.safeParse(row.previous);
   if(!ep.success||!pp.success)throw new RangeError('Historique de remboursement incohérent.');
   const e=ep.data,p=pp.data;
   if(e.operationId!==row.operationId||e.saleId!==row.saleId||e.version!==row.version||e.sale.syncSaleId!==row.saleId||e.sale.syncVersion!==e.version||e.sale.clientId!==row.clientId||p.saleId!==row.saleId||p.sale.syncSaleId!==row.saleId||p.sale.syncVersion!==p.version||p.version+1!==e.version||p.sale.clientId!==row.clientId||p.sale.createdAt!==e.sale.createdAt||tunisDay(e.sale.createdAt)!==row.saleDay||(row.refundDay!==null&&tunisDay(e.recordedAt)!==row.refundDay)||e.refund<=0||p.sale.paid-e.refund!==e.sale.paid||e.refund>Math.max(0,p.sale.paid-e.sale.total)||hash(e)!==row.hash||hash(p)!==row.previousHash)throw new RangeError('Historique de remboursement incohérent.');
   return {operationId:e.operationId,saleId:e.saleId,version:e.version,clientId:row.clientId as string,clientName:e.sale.clientName,ownerId:row.ownerId as string,ownerName:row.ownerName as string,saleDay:row.saleDay as string,actorId:row.actorId as string,actorName:row.actorName as string,recordedAt:e.recordedAt,refundDay:row.refundDay as string|null,previousPaid:p.sale.paid,currentPaid:e.sale.paid,refund:e.refund};
  });
  await db.query('COMMIT');return {version:5 as const,commercialId,day,closure:closure.rows[0]??{status:'open',version:0},entries,truncated:result.rows.length>200};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
