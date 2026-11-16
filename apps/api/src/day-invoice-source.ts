/** Projection PostgreSQL du client/jour pour le nouveau protocole, non exposée. */
import type {PoolClient} from 'pg';
import {summarizePreInvoice} from '@sls/domain';
import {parseStoredDayInvoicePayment} from './day-invoice-protocol.js';
import {parseStoredOldDebt} from './settlement-protocol.js';
import {readIdentifiedReferenceInTransaction} from './identified-reference.js';
import type {DayInvoicePayment} from '../../../packages/domain/src/day-invoice.js';
function tunisDay(iso:string):string {
 const d=new Date(iso);if(!Number.isFinite(d.getTime()))throw Error('Date de vente invalide.');
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d),get=(key:string)=>parts.find(p=>p.type===key)?.value;
 return `${get('year')}-${get('month')}-${get('day')}`;
}
/** Exige le verrou client/jour ainsi qu'une transaction du même client PG.
 * La route reste désactivée tant que les écritures de vente ne partagent pas ce verrou. */
export async function readServerDayInvoiceSource(db:PoolClient,event:DayInvoicePayment) {
 const reference=await readIdentifiedReferenceInTransaction(db,true);
 if(!reference.clients.some(c=>c.id===event.clientId))throw Error('Client introuvable.');
 const salesRows=await db.query(`WITH combined AS (
  SELECT sale_id,client_id,version,payload FROM demo_sale_events
  UNION ALL SELECT sale_id,client_id,version,payload FROM identified_sale_events
 ) SELECT DISTINCT ON(sale_id) sale_id AS "saleId",client_id AS "clientId",version,payload
 FROM combined WHERE client_id=$1 ORDER BY sale_id,version DESC`,[event.clientId]);
 const sales=salesRows.rows.filter(row=>tunisDay(row.payload?.sale?.createdAt)===event.day).map(row=>{
  const state=reference.saleStates.find(s=>s.saleId===row.saleId);
  if(!state || state.clientId!==event.clientId || state.version!==row.version || state.total!==String(row.payload?.sale?.total) || state.paid!==String(row.payload?.sale?.paid))throw Error('Vente serveur incohérente.');
  return {id:row.saleId as string,version:row.version as number,total:Number(state.total),paid:Number(state.paid)};
 });
 // Les anciens règlements globaux n'ont aucune attribution fiable à la facture du jour.
 const global=await db.query(`SELECT payload,NULL::text AS invoice_day,NULL::uuid AS operation_id,NULL::uuid AS client_id,NULL::text AS journal_day,NULL::text AS payload_hash FROM demo_settlements WHERE client_id=$1
 UNION ALL SELECT s.payload,m.invoice_day::text AS invoice_day,s.operation_id,s.client_id,s.journal_date::text AS journal_day,s.payload_hash FROM identified_settlements s LEFT JOIN identified_day_invoice_old_debt m ON m.operation_id=s.operation_id WHERE s.client_id=$1 OR s.payload->'settlement'->>'clientId'=$1::text`,[event.clientId]);
 for(const r of global.rows)if(r.invoice_day){try{parseStoredOldDebt(r);}catch{throw Error('Marqueur de dette incohérent.');}}
 if(global.rows.some(r=>r.invoice_day?event.day<r.invoice_day:tunisDay(r.payload?.settlement?.createdAt)===event.day))throw Error('Règlement global non attribué sur cette journée : rapprochement nécessaire.');
 // Contrôler tous les paiements du client avant de filtrer le jour : une
 // colonne client/jour altérée ne doit pas faire disparaître un règlement.
 const stored=await db.query(`SELECT operation_id,client_id,invoice_day::text AS invoice_day,event_day::text AS event_day,payload,payload_hash
 FROM identified_day_invoice_payments WHERE client_id=$1 OR payload->>'clientId'=$1::text ORDER BY operation_id`,[event.clientId]);
 const payments=stored.rows.map(row=>parseStoredDayInvoicePayment(row)).filter(p=>p.day===event.day);
 const candidates=reference.journalStates.filter(p=>p.clientId===event.clientId && p.journalDate===event.day);
 if(candidates.length>1)throw Error('Factures préétablies serveur en conflit.');
 let preInvoice:{id:string;version:number;total:number;paid:number;declared:boolean}|null=null;
 if(candidates[0]) {
  const p=candidates[0],proof=reference.journalProofs.find(x=>x.id===p.id),summary=summarizePreInvoice(p.total,p.receipts);
  if(!proof)throw Error('Version de facture serveur indisponible.');
  // Une ancienne ligne de dette ne permet pas de savoir si elle concernait la vente sur place.
  if(sales.length && summary.oldDebtPaid>0)throw Error('Règlement historique non attribué : rapprochement nécessaire.');
  const declarations=payments.filter(pmt=>pmt.preInvoice?.id===p.id && pmt.preInvoice.declare);
  if(declarations.length>1 || (declarations.length && summary.declared) || payments.some(pmt=>pmt.preInvoice?.id===p.id && (pmt.preInvoice.total!==p.total || pmt.preInvoice.version>proof.version)))throw Error('Déclaration de facture serveur incohérente.');
  preInvoice={id:p.id,version:proof.version,total:p.total,paid:summary.prePaid,declared:summary.declared||declarations.length===1};
 }
 if(payments.some(p=>p.preInvoice && p.preInvoice.id!==preInvoice?.id))throw Error('Paiement serveur rattaché à une autre facture.');
 return {clientId:event.clientId,day:event.day,preInvoice,sales,dayPayments:payments.map(p=>({id:p.operationId,amount:p.amount,declaration:p.mode==='Crédit'}))};
}
