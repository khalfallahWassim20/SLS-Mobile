/** Chronologie locale v6 : présentée par heure d'opération tunisienne. Ne
 * prétend pas contenir l'historique des autres téléphones. Transaction exclusive. */
import {canonicalJson} from '@sls/domain';
import {validateDayPayment,type DayInvoicePayment} from '../../packages/domain/src/day-invoice';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {readDayInvoiceClients} from './day-invoice-clients';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {readDayInvoiceOutbox} from './day-invoice-queue';
import {readOldDebtOutbox} from './day-invoice-old-debt-queue';
import {readLocalSaleCashLedger} from './credit-sale-refund-journal-prototype';
import {chronologicalOperations,operationDay} from './client-timeline';
import type {SavedSale,Settlement,TourPreInvoice,TourJournalReceipt} from './storage';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export type DayTimelineItem=
 |{type:'invoice';key:string;date:string;amount:number}
 |{type:'sale';key:string;date:string;originalTotal:number;currentTotal:number}
 |{type:'revision';key:string;date:string;previousTotal:number;currentTotal:number;refund:number}
 |{type:'receipt';key:string;date:string;prePaid:number;oldDebtPaid:number;mode:string;creditFull:boolean}
 |{type:'settlement';key:string;date:string;amount:number;mode:string;oldDebt:boolean}
 |{type:'payment';key:string;date:string;amount:number;mode:string;invoiceDay:string;pending:boolean};
const parse=(value:string)=>{try{const p=JSON.parse(value);if(!p||typeof p!=='object'||Array.isArray(p))throw Error();return p;}catch{throw Error('Historique local illisible.');}};
const validAmount=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;
export async function captureDayInvoiceTimeline(tx:Tx,identity:DeviceIdentity,clientId:string,digest:(s:string)=>Promise<string>,day?:string):Promise<DayTimelineItem[]>{
 const bound=await getDeviceIdentity(tx);if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur incohérent.');
 if(day){const d=new Date(`${day}T00:00:00.000Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==day)throw Error('Journée invalide.');}
 const reference=await readDayInvoiceReferenceCache(tx,identity),clients=await readDayInvoiceClients(tx,identity,digest),client=clients.clients.find(c=>c.id===clientId);
 if(!reference||!client||client.conflict)throw Error('Client ou historique indisponible.');
 const items:DayTimelineItem[]=[];
 const sales=(await tx.getAllAsync<{id:number;payload:string}>('SELECT id,payload FROM sales WHERE client_id=? ORDER BY id',clientId)).map(row=>({...parse(row.payload),id:row.id}) as SavedSale);
 // Le registre vérifie toute la chaîne de révisions et les origines locales.
 for(const originDay of new Set(sales.map(s=>operationDay(s.createdAt)))){if(!originDay)throw Error('Date de vente invalide.');await readLocalSaleCashLedger(tx,identity,sales,originDay);}
 for(const sale of sales){
  const revisions=await tx.getAllAsync<{id:number;createdAt:string;previous:string;current:string;refund:number}>('SELECT id,created_at AS createdAt,previous_payload AS previous,new_payload AS current,refund FROM sale_revisions WHERE sale_id=? ORDER BY id',sale.id);
  const original=revisions.length?parse(revisions[0].previous):sale;if(!validAmount(original.total)||!validAmount(sale.total))throw Error('Montant de vente invalide.');
  items.push({type:'sale',key:`sale:${sale.id}`,date:sale.createdAt,originalTotal:original.total,currentTotal:sale.total});
  for(const r of revisions){const a=parse(r.previous),b=parse(r.current);if(!validAmount(a.total)||!validAmount(b.total)||!validAmount(r.refund))throw Error('Révision de vente invalide.');items.push({type:'revision',key:`revision:${r.id}`,date:r.createdAt,previousTotal:a.total,currentTotal:b.total,refund:r.refund});}
 }
 const invoices=await tx.getAllAsync<{id:string;payload:string}>('SELECT id,payload FROM tour_pre_invoices WHERE client_id=? ORDER BY rowid',clientId);
 for(const row of invoices){const p=parse(row.payload) as TourPreInvoice;if(p.id!==row.id||p.clientId!==clientId||!validAmount(p.amount))throw Error('Préétablie locale incohérente.');items.push({type:'invoice',key:`invoice:${p.id}`,date:p.createdAt,amount:p.amount});}
 const receipts=await tx.getAllAsync<{id:string;payload:string}>('SELECT id,payload FROM tour_journal_receipts WHERE client_id=? ORDER BY rowid',clientId);
 for(const row of receipts){const r=parse(row.payload) as TourJournalReceipt;if(r.id!==row.id||r.clientId!==clientId||!validAmount(r.prePaid)||!validAmount(r.oldDebtPaid)||!['Espèces','Chèque','Virement'].includes(r.mode)||typeof r.creditFull!=='boolean')throw Error('Reçu local incohérent.');items.push({type:'receipt',key:`receipt:${r.id}`,date:r.createdAt,prePaid:r.prePaid,oldDebtPaid:r.oldDebtPaid,mode:r.mode,creditFull:r.creditFull});}
 const debts=await readOldDebtOutbox(tx,identity),oldIds=new Set(debts.map(entry=>entry.operationId));
 const settlements=await tx.getAllAsync<{id:number;payload:string}>('SELECT id,payload FROM settlements WHERE client_id=? ORDER BY id',clientId);
 for(const row of settlements){const p=parse(row.payload) as Settlement;if(p.clientId!==clientId||!validAmount(p.amount)||p.amount===0||!['Espèces','Chèque','Virement'].includes(p.mode)||!p.syncOperationId)throw Error('Règlement local incohérent.');items.push({type:'settlement',key:`settlement:${row.id}`,date:p.createdAt,amount:p.amount,mode:p.mode,oldDebt:oldIds.has(p.syncOperationId)||reference.oldDebtMarkers.some(m=>m.operationId===p.syncOperationId)});}
 const queue=await readDayInvoiceOutbox(tx,identity),queued=new Map(queue.map(q=>[q.operationId,q]));
 const payments=await tx.getAllAsync<{operationId:string;clientId:string;day:string;commercialId:string;serverOrigin:string;payload:string}>('SELECT operation_id AS operationId,client_id AS clientId,invoice_day AS day,commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM day_invoice_payments WHERE client_id=? ORDER BY operation_id',clientId);
 for(const row of payments){const p=parse(row.payload) as DayInvoicePayment;validateDayPayment(p);if(p.operationId!==row.operationId||p.clientId!==clientId||p.day!==row.day||row.clientId!==clientId||row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin)throw Error('Paiement local incohérent.');
  const q=queued.get(p.operationId),remote=reference.dayPayments.find(x=>x.operationId===p.operationId);if(q&&canonicalJson(parse(q.payload))!==canonicalJson(p)||remote&&canonicalJson(remote)!==canonicalJson(p)||!q&&!remote)throw Error('Preuve de paiement indisponible : rapprochement nécessaire.');
  items.push({type:'payment',key:`payment:${p.operationId}`,date:p.recordedAt,amount:p.amount,mode:p.mode,invoiceDay:p.day,pending:!!q});
 }
 // Une date illisible n'est jamais masquée par le filtre journal.
 return chronologicalOperations(day?items.filter(item=>operationDay(item.date)===day||operationDay(item.date)===null):items);
}
