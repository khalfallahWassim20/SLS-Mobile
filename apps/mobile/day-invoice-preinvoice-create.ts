/** Création locale préparatoire d'une préétablie v6. Transactions SQLite
 * exclusives obligatoires ; ce module ne modifie pas les écrans actifs. */
import {canonicalJson} from '@sls/domain';
import {getDeviceIdentity,assertDeviceWritable,recordDeviceOperation,type DeviceIdentity} from './identified-device';
import {assertLegacyMobileCreditSafe} from './credit-note-write-guard-prototype';
import {assertDayInvoiceSyncIdle} from './day-invoice-sync-lock';
import {assertDayInvoiceAttemptsSettled} from './day-invoice-attempt-guard';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {readDayInvoiceClients} from './day-invoice-clients';
import {captureDayInvoiceForm} from './day-invoice-form';
import {readOldDebtOutbox} from './day-invoice-old-debt-queue';
import {queueJournalSnapshot} from './journal-queue';
import {tunisDay} from './journal';
import type {TourPreInvoice} from './storage';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function captureNewDayPreinvoice(tx:Tx,identity:DeviceIdentity,clientId:string,day:string,amount:number,digest:(text:string)=>Promise<string>){
 const bound=await getDeviceIdentity(tx);if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur incohérent.');
 const d=new Date(`${day}T00:00:00.000Z`);if(!uuid.test(clientId)||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==day||!Number.isSafeInteger(amount)||amount<=0)throw Error('Client, journée ou montant invalide.');
 await assertLegacyMobileCreditSafe(tx,identity);await assertDeviceWritable(tx,identity,[day]);
 const ref=await readDayInvoiceReferenceCache(tx,identity);if(!ref)throw Error('Référence facture du jour indisponible.');
 if(ref.journalStates?.some(j=>j.clientId===clientId&&j.journalDate===day))throw Error('Une préétablie existe déjà pour ce client et cette journée.');
 if(ref.oldDebtMarkers.some(m=>m.invoiceDay>=day&&ref.settlementStates?.some(s=>s.operationId===m.operationId&&s.clientId===clientId)))throw Error('Règlement de dette existant : rapprochement nécessaire avant ajout de préétablie.');
 for(const entry of await readOldDebtOutbox(tx,identity)){const event=JSON.parse(entry.payload);if(event.event.settlement.clientId===clientId)throw Error('Règlement de dette en attente : synchronisez avant ajout de préétablie.');}
 const clients=await readDayInvoiceClients(tx,identity,digest),client=clients.clients.find(c=>c.id===clientId);if(!client||client.conflict||client.balance===null)throw Error('Client ou solde indisponible.');
 const invoice=await captureDayInvoiceForm(tx,identity,clientId,day,digest);
 if(invoice.source.preInvoice)throw Error('Une préétablie existe déjà pour ce client et cette journée.');
 if(invoice.view.payments.length)throw Error('Facture déjà réglée : ajout de préétablie indisponible.');
 const total=BigInt(invoice.view.total)+BigInt(amount);if(total>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Facture trop élevée.');
 const fingerprint=canonicalJson({clientId,day,amount,clientName:client.name,sector:client.sector,balance:client.balance,invoice:invoice.fingerprint});
 // La préétablie non déclarée n'affecte pas encore le solde global.
 return {clientId,clientName:client.name,sector:client.sector,day,amount,invoiceTotal:Number(total),balance:client.balance,fingerprint};
}
export type NewDayPreinvoice={clientId:string;day:string;amount:number;fingerprint:string;invoiceId:string;operationId:string;createdAt:string};
export async function confirmNewDayPreinvoice(tx:Tx,identity:DeviceIdentity,input:NewDayPreinvoice,digest:(text:string)=>Promise<string>){
 if(!uuid.test(input.invoiceId)||!uuid.test(input.operationId)||input.invoiceId.toLowerCase()===input.operationId.toLowerCase()||typeof input.createdAt!=='string'||!Number.isFinite(Date.parse(input.createdAt))||new Date(input.createdAt).toISOString()!==input.createdAt||tunisDay(new Date(input.createdAt))!==input.day||typeof input.fingerprint!=='string'||!input.fingerprint)throw Error('Identifiants ou date de préétablie invalides.');
 const bound=await getDeviceIdentity(tx);if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur incohérent.');
 const marker=await tx.getFirstAsync<{commercialId:string;kind:string;entityId:string;recordedAt:string}>('SELECT commercial_id AS commercialId,operation_kind AS kind,entity_id AS entityId,recorded_at AS recordedAt FROM identified_local_operations WHERE operation_id=?',input.operationId);
 if(marker){
  const row=await tx.getFirstAsync<{payload:string;clientId:string;day:string}>('SELECT payload,client_id AS clientId,journal_date AS day FROM tour_pre_invoices WHERE id=?',input.invoiceId);
  const state=await tx.getFirstAsync<{version:number;payload:string}>('SELECT version,payload FROM journal_sync_state WHERE invoice_id=?',input.invoiceId);
  let invoice:TourPreInvoice,snapshot:any;try{invoice=JSON.parse(row?.payload??'');snapshot=JSON.parse(state?.payload??'');}catch{throw Error('Préétablie locale illisible.');}
  if(marker.commercialId!==identity.commercialId||marker.kind!=='journal'||marker.entityId!==input.invoiceId||marker.recordedAt!==input.createdAt||!row||row.clientId!==input.clientId||row.day!==input.day||invoice.id!==input.invoiceId||invoice.clientId!==input.clientId||invoice.journalDate!==input.day||invoice.amount!==input.amount||invoice.createdAt!==input.createdAt||state?.version!==1||snapshot?.operationId!==input.operationId||snapshot.version!==1||canonicalJson(snapshot.invoice)!==canonicalJson(invoice)||canonicalJson(snapshot.receipts)!=='[]')throw Error('Préétablie déjà enregistrée avec des données différentes.');
  const queued=await tx.getFirstAsync<{payload:string}>('SELECT payload FROM journal_sync_outbox WHERE operation_id=?',input.operationId);
  if(queued){if(canonicalJson(JSON.parse(queued.payload))!==canonicalJson(snapshot))throw Error('File du journal incohérente.');}
  else{const ref=await readDayInvoiceReferenceCache(tx,identity),proof=ref?.journalProofs.find(p=>p.id===input.invoiceId);if(!proof||proof.version!==1||proof.hash!==await digest(canonicalJson(snapshot)))throw Error('Preuve de préétablie indisponible : rapprochement nécessaire.');}
  return {status:'duplicate' as const,invoice};
 }
 assertDayInvoiceSyncIdle();await assertDayInvoiceAttemptsSettled(tx,identity);
 const current=await captureNewDayPreinvoice(tx,identity,input.clientId,input.day,input.amount,digest);if(current.fingerprint!==input.fingerprint)throw Error('Facture ou solde modifié : vérifiez à nouveau.');
 const collision=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM identified_local_operations WHERE lower(operation_id)=lower(?) OR lower(entity_id)=lower(?)) OR EXISTS(SELECT 1 FROM sales_outbox WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM journal_sync_outbox WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_payments WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_old_debt_local WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM offline_credit_prototype WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM tour_pre_invoices WHERE lower(id)=lower(?)) AS n`,input.operationId,input.invoiceId,input.operationId,input.operationId,input.operationId,input.operationId,input.operationId,input.invoiceId);
 const ref=await readDayInvoiceReferenceCache(tx,identity);if(!collision||collision.n||!ref||ref.journalStates?.some(j=>j.id.toLowerCase()===input.invoiceId.toLowerCase())||ref.dayPayments.some(p=>p.operationId.toLowerCase()===input.operationId.toLowerCase())||ref.settlementStates?.some(s=>s.operationId.toLowerCase()===input.operationId.toLowerCase()))throw Error('Identifiant de préétablie déjà utilisé.');
 const invoice:TourPreInvoice={id:input.invoiceId,journalDate:input.day,clientId:input.clientId,clientName:current.clientName,sector:current.sector,amount:input.amount,createdAt:input.createdAt};
 await tx.runAsync('INSERT INTO tour_pre_invoices(id,journal_date,client_id,payload) VALUES(?,?,?,?)',invoice.id,invoice.journalDate,invoice.clientId,JSON.stringify(invoice));
 await queueJournalSnapshot(tx,invoice.id,()=>input.operationId);await recordDeviceOperation(tx,identity,input.operationId,'journal',invoice.id,invoice.createdAt);
 return {status:'created' as const,invoice};
}
