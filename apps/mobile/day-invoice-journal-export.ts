/** Capture expérimentale pour les exports locaux v6 ; à exécuter dans la
 * même transaction exclusive que le reste du journal, sans la raccorder aux
 * anciens écrans tant que leurs lectures ne connaissent pas la v6. */
import {readLocalDayInvoiceCash} from './day-invoice-cash';
import {readDayInvoiceOutbox} from './day-invoice-queue';
import {assertLocalDayPaymentProofs} from './day-invoice-payment-proof';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import type {JournalExport} from './journal-export';
import {tunisDay,buildJournal} from './journal';
import {readDayInvoiceClients} from './day-invoice-clients';
import {assertDayInvoiceAttemptsSettled} from './day-invoice-attempt-guard';
import {readLocalSaleCashLedger} from './credit-sale-refund-journal-prototype';
import {readTourExpenses} from './tour-expenses';
import type {SavedSale,TourPreInvoice,TourJournalReceipt,Settlement} from './storage';
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

/** Journal local v6 capturé sous une seule transaction. Ce n'est pas un journal
 * consolidé : les opérations sur d'autres téléphones peuvent manquer. Une
 * ancienne écriture ambiguë bloque l'export au lieu d'être classée en dette. */
export async function captureDayInvoiceJournalExport(tx:Tx,identity:DeviceIdentity,day:string,commercial:string,digest:(text:string)=>Promise<string>):Promise<JournalExport>{
 const date=new Date(`${day}T00:00:00.000Z`);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day||typeof commercial!=='string'||!commercial.trim())throw Error('Journée ou commercial invalide.');
 await assertDayInvoiceAttemptsSettled(tx,identity,day);
 const snapshot=await readDayInvoiceClients(tx,identity,digest),reference=await readDayInvoiceReferenceCache(tx,identity);
 if(!reference||snapshot.clients.some(c=>c.conflict))throw Error('Solde ou référence en conflit : export refusé.');
 const parse=(raw:string):any=>{try{const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw Error('Journal local illisible.');}};
 const saleRows=await tx.getAllAsync<{id:number;payload:string}>('SELECT id,payload FROM sales ORDER BY id');
 const sales=saleRows.map(row=>({...parse(row.payload),id:row.id}) as SavedSale);
 const invoiceRows=await tx.getAllAsync<{payload:string}>('SELECT payload FROM tour_pre_invoices ORDER BY rowid');
 const invoices=invoiceRows.map(row=>parse(row.payload) as TourPreInvoice);
 const receiptRows=await tx.getAllAsync<{payload:string}>('SELECT payload FROM tour_journal_receipts ORDER BY rowid');
 const receipts=receiptRows.map(row=>parse(row.payload) as TourJournalReceipt);
 // Le moteur historique d'export classe les reçus par date de facture. Ne
 // jamais masquer un reçu encaissé un autre jour sous cette approximation.
 for(const receipt of receipts){if(!Number.isFinite(Date.parse(receipt.createdAt)))throw Error('Date de reçu invalide : export refusé.');const eventDay=tunisDay(new Date(receipt.createdAt));if(eventDay!==receipt.journalDate&&(eventDay===day||receipt.journalDate===day))throw Error('Reçu historique sur plusieurs journées : rapprochement requis avant export.');}
 const settlementRows=await tx.getAllAsync<{id:number;payload:string}>('SELECT id,payload FROM settlements ORDER BY id');
 const settlements=settlementRows.map(row=>({...parse(row.payload),id:row.id}) as Settlement);
 const debts=await tx.getAllAsync<{operationId:string}>('SELECT operation_id AS operationId FROM day_invoice_old_debt_local');
 const oldIds=new Set([...debts.map(d=>d.operationId),...reference.oldDebtMarkers.map(d=>d.operationId)]);
 for(const settlement of settlements){if(!Number.isFinite(Date.parse(settlement.createdAt)))throw Error('Date de règlement invalide : export refusé.');if(tunisDay(new Date(settlement.createdAt))===day&&(!settlement.syncOperationId||!oldIds.has(settlement.syncOperationId)))throw Error('Règlement historique non attribué : rapprochement requis avant export.');}
 const sectors=new Map(snapshot.clients.map(c=>[c.id,c.sector])),rows=buildJournal(day,invoices,sales,sectors);
 const ledger=await readLocalSaleCashLedger(tx,identity,sales,day),dayInvoicePayments=await captureDayInvoiceExportPayments(tx,identity,day),expenses=await readTourExpenses(tx,identity);
 return {day,commercial:commercial.trim(),rows,receipts,settlements,clientSectors:Object.fromEntries(sectors),initialSalePayments:ledger.initialPayments,saleRefunds:ledger.refunds,dayInvoicePayments,expenses};
}
