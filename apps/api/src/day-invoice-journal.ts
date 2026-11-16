/** Encaissements unifiés reçus, attribués à leur date d'encaissement et au
 * commercial qui les a saisis, pas à la date de la facture ni à son auteur. */
import type {PoolClient} from 'pg';
import {parseDayInvoicePayment,dayInvoicePaymentHash} from './day-invoice-protocol.js';
import {journalDateSchema} from './journal-protocol.js';
import {z} from 'zod';
import {parseStoredOldDebt} from './settlement-protocol.js';
import type {DayInvoicePayment} from '../../../packages/domain/src/day-invoice.js';
const checked=(n:bigint)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw RangeError('Total de paiement trop élevé.');return Number(n);};
const dayOf=(at:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
export async function readDayInvoiceJournalPayments(db:PoolClient,commercialId:string,day:string) {
 z.string().uuid().parse(commercialId);journalDateSchema.parse(day);
 const exists=await db.query("SELECT to_regclass('identified_day_invoice_payments') IS NOT NULL AS present");
 if(typeof exists.rows[0]?.present!=='boolean')throw Error('État du registre facture du jour indisponible.');
 if(!exists.rows[0].present)return {payments:[],total:0};
 const records=await db.query(`SELECT p.operation_id,p.client_id,p.invoice_day::text AS invoice_day,p.event_day::text AS event_day,p.payload,p.payload_hash,c.name,c.sector
 FROM identified_day_invoice_payments p JOIN clients c ON c.id=p.client_id
 WHERE p.commercial_id=$1 AND p.event_day=$2::date ORDER BY p.operation_id LIMIT 20001`,[commercialId,day]);
 if(records.rows.length>20000)throw Error('Trop de règlements unifiés : comparaison incomplète refusée.');
 let total=0n;
 const payments=records.rows.map(r=>{
  const p=parseDayInvoicePayment(r.payload);
  if(p.operationId!==r.operation_id||p.clientId!==r.client_id||p.day!==r.invoice_day||dayOf(p.recordedAt)!==r.event_day||r.event_day!==day||dayInvoicePaymentHash(p)!==r.payload_hash||typeof r.name!=='string'||typeof r.sector!=='string')throw Error('Paiement unifié du journal incohérent.');
  total+=BigInt(p.amount);return {payment:p,operationId:p.operationId,clientId:p.clientId,clientName:r.name,sector:r.sector,invoiceDay:p.day,recordedAt:p.recordedAt,amount:p.amount,mode:p.mode,chequeNumber:p.chequeNumber,chequeBank:p.chequeBank,chequeDue:p.chequeDue,declaresInvoice:!!p.preInvoice?.declare,preInvoiceId:p.preInvoice?.id??null};
 });
 return {payments,total:checked(total)};
}
/** Déclarations au titre de factures de ce jour, indépendamment du jour et
 * du commercial de l'encaissement. Ne les compte pas comme recettes ici. */
export async function readDayInvoiceDeclarations(db:PoolClient,day:string,clientIds:string[]) {
 journalDateSchema.parse(day);for(const id of clientIds)z.string().uuid().parse(id);
 if(!clientIds.length)return new Map<string,{clientId:string;total:number;payment:DayInvoicePayment}>();
 const exists=await db.query("SELECT to_regclass('identified_day_invoice_payments') IS NOT NULL AS present");
 if(typeof exists.rows[0]?.present!=='boolean')throw Error('État du registre facture du jour indisponible.');
 if(!exists.rows[0].present)return new Map<string,{clientId:string;total:number;payment:DayInvoicePayment}>();
 const records=await db.query(`SELECT operation_id,client_id,invoice_day::text AS invoice_day,event_day::text AS event_day,payload,payload_hash
 FROM identified_day_invoice_payments WHERE invoice_day=$1::date AND client_id=ANY($2::uuid[]) ORDER BY operation_id LIMIT 20001`,[day,clientIds]);
 if(records.rows.length>20000)throw Error('Trop de règlements unifiés : déclarations incomplètes.');
 const declared=new Map<string,{clientId:string;total:number;payment:DayInvoicePayment}>();
 for(const r of records.rows){const p=parseDayInvoicePayment(r.payload);
  if(p.operationId!==r.operation_id||p.clientId!==r.client_id||p.day!==r.invoice_day||p.day!==day||dayOf(p.recordedAt)!==r.event_day||dayInvoicePaymentHash(p)!==r.payload_hash)throw Error('Déclaration de facture du jour incohérente.');
  if(p.preInvoice?.declare){if(declared.has(p.preInvoice.id))throw Error('Déclaration de facture du jour dupliquée.');declared.set(p.preInvoice.id,{clientId:p.clientId,total:p.preInvoice.total,payment:p});}
 }
 return declared;
}

/** La déclaration affecte la facture de son propriétaire même si elle a été
 * enregistrée par une autre caisse ou à une date ultérieure. */
export async function readDayInvoiceOwnerDeclarations(db:PoolClient,commercialId:string,day:string):Promise<DayInvoicePayment[]> {
 z.string().uuid().parse(commercialId);journalDateSchema.parse(day);
 const invoices=await db.query('SELECT id,client_id FROM identified_journal_invoices WHERE commercial_id=$1 AND journal_date=$2::date ORDER BY id LIMIT 1001',[commercialId,day]);
 if(invoices.rows.length>1000)throw Error('Trop de factures : déclarations incomplètes.');
 const declarations=await readDayInvoiceDeclarations(db,day,invoices.rows.map(r=>r.client_id));
 const owned=new Map(invoices.rows.map(r=>[r.id,r.client_id]));
 for(const [id,p] of declarations)if(owned.get(id)!==p.clientId)throw Error('Déclaration de facture attribuée à un autre propriétaire.');
 return [...declarations.values()].map(p=>p.payment);
}

/** Encaissements explicitement affectés à l'ancienne dette, par commercial et
 * jour de saisie. Ils restent inclus une seule fois dans les règlements globaux. */
export async function readDayInvoiceJournalOldDebts(db:PoolClient,commercialId:string,day:string){
 z.string().uuid().parse(commercialId);journalDateSchema.parse(day);
 const exists=await db.query("SELECT to_regclass('identified_day_invoice_old_debt') IS NOT NULL AS present");
 if(typeof exists.rows[0]?.present!=='boolean')throw Error('État du registre ancienne dette indisponible.');
 if(!exists.rows[0].present)return {payments:[],total:0};
 const records=await db.query(`SELECT s.operation_id,s.client_id,s.commercial_id,s.journal_date::text AS journal_day,m.invoice_day::text AS invoice_day,s.payload,s.payload_hash,c.name,c.sector
 FROM identified_day_invoice_old_debt m JOIN identified_settlements s ON s.operation_id=m.operation_id JOIN clients c ON c.id=s.client_id
 WHERE s.commercial_id=$1 AND s.journal_date=$2::date ORDER BY s.operation_id LIMIT 20001`,[commercialId,day]);
 if(records.rows.length>20000)throw Error('Trop de règlements ancienne dette : comparaison incomplète refusée.');
 let total=0n;
 const payments=records.rows.map(row=>{
  let event:ReturnType<typeof parseStoredOldDebt>;try{event=parseStoredOldDebt(row);}catch{throw Error('Règlement ancienne dette du journal incohérent.');}const p=event.settlement;
  if(row.commercial_id!==commercialId||row.journal_day!==day||typeof row.name!=='string'||typeof row.sector!=='string')throw Error('Règlement ancienne dette du journal incohérent.');
  total+=BigInt(p.amount);return {operationId:event.operationId,clientId:p.clientId,clientName:row.name,sector:row.sector,recordedAt:p.createdAt,amount:p.amount,mode:p.mode,chequeNumber:p.chequeNumber,chequeBank:p.chequeBank,chequeDue:p.chequeDue};
 });
 return {payments,total:checked(total)};
}
