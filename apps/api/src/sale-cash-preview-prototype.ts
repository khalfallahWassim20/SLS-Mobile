/** Calcul indicatif de flux des ventes uniquement. Aucun changement de solde,
 * aucune clôture et aucun déblocage. À lire dans un instantané REPEATABLE READ. */
import {createHash} from 'node:crypto';
import {calculateInvoice} from '@sls/domain';
import type {PoolClient} from 'pg';
import {saleEventSchema} from './identified-operations.js';
const dayOf=(value:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safe=(n:bigint)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw new RangeError('Flux de ventes trop élevé.');return Number(n);};
/** Montant initial imputé au créateur/date de vente, remboursements imputés à
 * l'auteur/date de chaque modification. Les avoirs et autres encaissements ne
 * sont pas inclus. Les historiques partiels et dates incertaines sont refusés. */
export async function readSaleCashPreview(db:PoolClient,commercialId:string,day:string){
 const relevant=await db.query(`SELECT DISTINCT sale_id AS "saleId" FROM identified_sale_events
  WHERE (version=1 AND commercial_id=$1 AND journal_date=$2::date)
   OR (version>1 AND commercial_id=$1 AND (event_date=$2::date OR event_date IS NULL) AND (payload->>'refund')::numeric>0)
  ORDER BY sale_id LIMIT 201`,[commercialId,day]);
 if(relevant.rows.length>200)return {available:false as const,reason:'Plus de 200 ventes concernées : aperçu incomplet refusé.'};
 let received=0n,refund=0n;
 const initialEvents:{operationId:string;saleId:string;clientId:string;recordedAt:string;paid:number}[]=[];
 const refundEvents:{operationId:string;saleId:string;version:number;clientId:string;clientName:string;recordedAt:string;refund:number}[]=[];
 const entries:{saleId:string;clientId:string;clientName:string;saleDay:string;version:number;total:number;paid:number;initialPaid:number;receivedHere:number;refundedHere:number}[]=[];
 for(const row of relevant.rows){
  const events=await db.query(`SELECT operation_id AS "operationId",sale_id AS "saleId",version,client_id AS "clientId",commercial_id AS "actorId",journal_date::text AS "saleDay",event_date::text AS "eventDay",payload,payload_hash AS hash
   FROM identified_sale_events WHERE sale_id=$1 ORDER BY version LIMIT 201`,[row.saleId]);
  const legacy=await db.query('SELECT 1 FROM demo_sale_events WHERE sale_id=$1 LIMIT 1',[row.saleId]);
  if(legacy.rows.length||!events.rows.length||events.rows.length>200)return {available:false as const,reason:'Une vente ancienne ou un historique de plus de 200 versions exige un contrôle manuel.'};
  let previous:ReturnType<typeof saleEventSchema.parse>|null=null,owner:string|undefined,client:string|undefined,saleDay:string|undefined,refundHere=0n,initialPaid=0,firstOperation='',firstAt='';
  for(const [index,r] of events.rows.entries()){
   const parsed=saleEventSchema.safeParse(r.payload);if(!parsed.success)throw new RangeError('Historique de vente incohérent : aperçu des flux refusé.');const event=parsed.data;
   if(!r.eventDay)return {available:false as const,reason:'Date d’événement manquante : aperçu des flux indisponible.'};
   if(event.operationId!==r.operationId||event.saleId!==row.saleId||r.saleId!==row.saleId||event.version!==index+1||r.version!==event.version||event.sale.syncSaleId!==row.saleId||event.sale.syncVersion!==event.version||event.sale.clientId!==r.clientId||hash(event)!==r.hash||dayOf(event.recordedAt)!==r.eventDay||dayOf(event.sale.createdAt)!==r.saleDay)throw new RangeError('Historique de vente incohérent : aperçu des flux refusé.');
   const total=calculateInvoice(event.sale.lines.map(l=>({quantity:l.quantity,unitPrice:l.unitPrice,discountRate:l.discount,vatRate:l.vat}))).total;
   if(total!==event.sale.total||event.sale.remaining!==Math.max(0,event.sale.total-event.sale.paid)||Date.parse(event.recordedAt)<Date.parse(event.sale.createdAt))throw new RangeError('Totaux de vente incohérents : aperçu des flux refusé.');
   if(!previous){owner=r.actorId;client=r.clientId;saleDay=r.saleDay;initialPaid=event.sale.paid;firstOperation=event.operationId;firstAt=event.recordedAt;if(event.refund!==0||initialPaid>event.sale.total||Date.parse(event.recordedAt)!==Date.parse(event.sale.createdAt))throw new RangeError('Premier paiement incohérent.');}
   else if(r.clientId!==client||r.saleDay!==saleDay||event.sale.createdAt!==previous.sale.createdAt||Date.parse(event.recordedAt)<Date.parse(previous.recordedAt)||event.sale.paid!==previous.sale.paid-event.refund||event.refund>Math.max(0,previous.sale.paid-event.sale.total))throw new RangeError('Révision de vente incohérente : aperçu des flux refusé.');
   if(r.actorId===commercialId&&r.eventDay===day){refundHere+=BigInt(event.refund);if(event.refund>0)refundEvents.push({operationId:event.operationId,saleId:event.saleId,version:event.version,clientId:event.sale.clientId,clientName:event.sale.clientName,recordedAt:event.recordedAt,refund:event.refund});}
   previous=event;
  }
  if(!previous||!owner||!client||!saleDay)throw new RangeError('Historique de vente incomplet.');
  const here=owner===commercialId&&saleDay===day?initialPaid:0;
  if(owner===commercialId&&saleDay===day)initialEvents.push({operationId:firstOperation,saleId:row.saleId,clientId:client,recordedAt:firstAt,paid:initialPaid});
  received+=BigInt(here);refund+=refundHere;
  entries.push({saleId:row.saleId as string,clientId:client,clientName:previous.sale.clientName,saleDay,version:previous.version,total:previous.sale.total,paid:previous.sale.paid,initialPaid,receivedHere:here,refundedHere:safe(refundHere)});
 }
 return {available:true as const,entries,initialEvents,refundEvents,received:safe(received),refund:safe(refund),net:safe(received-refund)};
}
