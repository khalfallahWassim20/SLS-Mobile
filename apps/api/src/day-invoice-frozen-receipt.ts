/** Reçu historique de compensation : figé lors de la transaction d'écriture.
 * Il décrit cet instant, pas le solde courant ni un remboursement physique. */
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {canonicalJson} from '@sls/domain';
import {saleEventSchema} from './identified-sale-protocol.js';
import {compensationSchema,compensationHash} from './day-invoice-compensation.js';
import {JournalConflict} from './journal-store.js';
const id=z.string().uuid(),money=z.number().int().safe().nonnegative();
const projectionSchema=z.object({operationId:id,clientId:id,commercialId:id,invoiceDay:z.string(),eventDay:z.string(),recordedAt:z.string().datetime(),choice:z.enum(['refund','credit']),compensation:money,total:money,paidBeforeCompensation:money,applied:money,remaining:money,balance:z.number().int().safe(),refund:money,credit:money}).strict();
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const eventHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tunisDay=(value:string)=>{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));const get=(key:string)=>parts.find(p=>p.type===key)?.value;return `${get('year')}-${get('month')}-${get('day')}`;};
function verify(event:ReturnType<typeof saleEventSchema.parse>,choice:ReturnType<typeof compensationSchema.parse>,projection:unknown,commercialId:string){
 const p=projectionSchema.parse(projection),total=choice.paid-choice.amount;
 if(choice.amount<=0||choice.amount>choice.paid||choice.paid>choice.previousTotal||event.version<2||event.refund!==0||p.operationId!==event.operationId||p.clientId!==event.sale.clientId||p.commercialId!==commercialId||p.invoiceDay!==tunisDay(event.sale.createdAt)||p.eventDay!==tunisDay(event.recordedAt)||p.recordedAt!==event.recordedAt||p.choice!==choice.choice||p.compensation!==choice.amount||p.paidBeforeCompensation!==choice.paid||p.total!==total||p.applied!==total||p.remaining!==0||p.refund!==(choice.choice==='refund'?choice.amount:0)||p.credit!==(choice.choice==='credit'?choice.amount:0))throw new JournalConflict('Reçu historique de compensation incohérent.');
 return p;
}
export async function freezeCompensationReceipt(db:PoolClient,event:ReturnType<typeof saleEventSchema.parse>,choice:ReturnType<typeof compensationSchema.parse>,commercialId:string,projection:unknown){
 const p=verify(event,choice,projection,commercialId);
 await db.query('INSERT INTO identified_day_invoice_compensation_receipts(operation_id,commercial_id,projection,projection_hash) VALUES($1,$2,$3::jsonb,$4)',[event.operationId,commercialId,JSON.stringify(p),hash(p)]);
}
/** Retourne null uniquement pour un ancien enregistrement sans reçu figé. */
export async function readFrozenCompensationReceipt(db:PoolClient,operationId:string,commercialId:string){
 const marker=await db.query('SELECT receipt_required,commercial_id FROM identified_day_invoice_compensations WHERE operation_id=$1',[operationId]);
 if(marker.rows.length!==1||marker.rows[0].commercial_id!==commercialId||typeof marker.rows[0].receipt_required!=='boolean')throw new JournalConflict('Compensation ou propriétaire incohérent.');
 const required=marker.rows[0].receipt_required;
 const exists=await db.query("SELECT to_regclass('identified_day_invoice_compensation_receipts') IS NOT NULL AS present");
 if(exists.rows[0]?.present===false&&!required)return null;
 if(exists.rows[0]?.present!==true)throw new JournalConflict('Registre des reçus indisponible.');
 const result=await db.query(`SELECT r.commercial_id AS receipt_commercial,r.projection,r.projection_hash,
 c.client_id,c.commercial_id,c.invoice_day::text AS invoice_day,c.event_day::text AS event_day,c.payload AS compensation,c.payload_hash AS compensation_hash,
 s.sale_id,s.version,s.client_id AS sale_client,s.commercial_id AS sale_commercial,s.journal_date::text AS sale_day,s.event_date::text AS sale_event_day,s.payload AS event,s.payload_hash AS event_hash
 FROM identified_day_invoice_compensation_receipts r JOIN identified_day_invoice_compensations c ON c.operation_id=r.operation_id JOIN identified_sale_events s ON s.operation_id=r.operation_id WHERE r.operation_id=$1`,[operationId]);
 if(!result.rows.length){if(required)throw new JournalConflict('Reçu historique absent : rapprochement nécessaire.');return null;}
 if(!required||result.rows.length!==1)throw new JournalConflict('Reçu de compensation ambigu.');
 try{
  const r=result.rows[0],event=saleEventSchema.parse(r.event),compensation=compensationSchema.parse(r.compensation),projection=verify(event,compensation,r.projection,commercialId);
  if(r.receipt_commercial!==commercialId||r.commercial_id!==commercialId||r.sale_commercial!==commercialId||r.client_id!==event.sale.clientId||r.sale_client!==r.client_id||r.sale_id!==event.saleId||r.version!==event.version||event.sale.syncSaleId!==event.saleId||event.sale.syncVersion!==event.version||event.operationId!==operationId||r.invoice_day!==projection.invoiceDay||r.event_day!==projection.eventDay||r.sale_day!==r.invoice_day||r.sale_event_day!==r.event_day||r.event_hash!==eventHash(event)||r.compensation_hash!==compensationHash(compensation)||r.projection_hash!==hash(projection))throw Error();
  return {event,compensation,projection};
 }catch{throw new JournalConflict('Reçu historique de compensation altéré : rapprochement nécessaire.');}
}
