/** Capture expérimentale pour les exports locaux v6 ; à exécuter dans la
 * même transaction exclusive que le reste du journal, sans la raccorder aux
 * anciens écrans tant que leurs lectures ne connaissent pas la v6. */
import {readLocalDayInvoiceCash} from './day-invoice-cash';
import {readDayInvoiceOutbox} from './day-invoice-queue';
import {assertLocalDayPaymentProofs} from './day-invoice-payment-proof';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import type {JournalExport} from './journal-export';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export async function captureDayInvoiceExportPayments(tx:Tx,identity:DeviceIdentity,day:string):Promise<NonNullable<JournalExport['dayInvoicePayments']>> {
 const bound=await getDeviceIdentity(tx);if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin)throw Error('Identité du journal incohérente.');
 const reference=await readDayInvoiceReferenceCache(tx,identity);if(!reference)throw Error('Référence facture du jour indisponible pour l’export.');
 const payments=await readLocalDayInvoiceCash(tx,identity,day);
 const pending=await readDayInvoiceOutbox(tx,identity);
 assertLocalDayPaymentProofs(payments,pending,reference);
 const pendingIds=new Set(pending.map(p=>p.operationId));
 return payments.map(payment=>{const client=reference.clients.find(c=>c.id===payment.clientId);if(!client||!client.name.trim())throw Error('Client du règlement indisponible pour l’export.');return {payment,clientName:client.name,sector:client.sector,pending:pendingIds.has(payment.operationId)};});
}
