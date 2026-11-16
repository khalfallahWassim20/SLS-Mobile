/** Capture v6 expérimentale, à lire dans la même transaction exclusive que
 * les autres preuves. Ne débloque ni l'interface ni la clôture v5. */
import {validateDayPayment,type DayInvoicePayment} from '../../packages/domain/src/day-invoice';
import {tunisDay} from './journal';
import type {DayInvoiceIdentity} from './day-invoice-queue';
type Tx={getAllAsync<T>(sql:string,...args:(string|number|null)[]):Promise<T[]>};
export async function readLocalDayInvoiceCash(tx:Tx,identity:DayInvoiceIdentity,day:string):Promise<DayInvoicePayment[]> {
 const date=new Date(`${day}T00:00:00.000Z`);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.commercialId))throw Error('Identité ou journée invalide.');
 try{const origin=new URL(identity.serverOrigin);if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.origin!==identity.serverOrigin)throw Error();}catch{throw Error('Adresse serveur invalide.');}
 const rows=await tx.getAllAsync<{operationId:string;clientId:string;invoiceDay:string;payload:string;commercialId:string;serverOrigin:string}>(`SELECT operation_id AS operationId,client_id AS clientId,invoice_day AS invoiceDay,payload,commercial_id AS commercialId,server_origin AS serverOrigin FROM day_invoice_payments ORDER BY operation_id LIMIT 20001`);
 if(rows.length>20000)throw Error('Trop de règlements unifiés : comparaison incomplète refusée.');
 const result:DayInvoicePayment[]=[];
 for(const row of rows){
  let p:DayInvoicePayment;try{p=JSON.parse(row.payload);validateDayPayment(p);}catch{throw Error('Paiement unifié local illisible.');}
  if(p.operationId!==row.operationId||p.clientId!==row.clientId||p.day!==row.invoiceDay)throw Error('Paiement unifié local incohérent.');
  if(row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin)throw Error('Paiement unifié lié à un autre commercial ou serveur.');
  if(tunisDay(new Date(p.recordedAt))!==day)continue;
  result.push(p);
 }
 return result;
}
