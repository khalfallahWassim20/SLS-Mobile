import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {saleEventSchema} from './identified-operations.js';

/** Détail informatif des remboursements déjà inclus dans les paiements nets.
 * Le verrou de lecture du journal interdit les remboursements hors périmètre.
 * Une preuve incomplète ou incohérente interdit l'affichage et l'export. */
export async function readSameDaySaleRefunds(db:PoolClient,commercialId:string,day:string){
 const result=await db.query(`SELECT r.operation_id AS "operationId",r.sale_id AS "saleId",r.version,r.client_id AS "clientId",r.payload,r.payload_hash AS hash,
  p.payload AS previous,p.payload_hash AS "previousHash"
  FROM identified_sale_events r
  JOIN identified_sale_events origin ON origin.sale_id=r.sale_id AND origin.version=1
  LEFT JOIN identified_sale_events p ON p.sale_id=r.sale_id AND p.version=r.version-1
  WHERE r.version>1 AND r.commercial_id=$1 AND origin.commercial_id=$1
   AND origin.journal_date=$2::date AND r.event_date=$2::date AND (r.payload->>'refund')::numeric>0
  ORDER BY r.payload->>'recordedAt',r.operation_id`,[commercialId,day]);
 const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
 let total=0n;
 const events=result.rows.map(row=>{
  const parsed=saleEventSchema.safeParse(row.payload),prior=saleEventSchema.safeParse(row.previous);
  if(!parsed.success||!prior.success)throw new RangeError('Historique de remboursement incohérent.');
  const event=parsed.data,previous=prior.data;
  const actualDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(event.recordedAt));
  if(event.operationId!==row.operationId||event.saleId!==row.saleId||event.sale.clientId!==row.clientId||event.version!==row.version||event.sale.syncSaleId!==row.saleId||event.sale.syncVersion!==event.version||previous.saleId!==row.saleId||previous.sale.syncSaleId!==row.saleId||previous.sale.syncVersion!==previous.version||previous.version+1!==event.version||previous.sale.clientId!==row.clientId||previous.sale.createdAt!==event.sale.createdAt||event.refund<=0||previous.sale.paid-event.refund!==event.sale.paid||event.refund>Math.max(0,previous.sale.paid-event.sale.total)||actualDay!==day||hash(event)!==row.hash||hash(previous)!==row.previousHash)throw new RangeError('Historique de remboursement incohérent.');
  total+=BigInt(event.refund);
  return {operationId:event.operationId,saleId:event.saleId,version:event.version,clientId:row.clientId as string,clientName:event.sale.clientName,recordedAt:event.recordedAt,refund:event.refund};
 });
 if(total>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Total des remboursements trop élevé.');
 return {saleRefundEvents:events,saleRefundTotal:Number(total)};
}
