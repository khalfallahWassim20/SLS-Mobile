/** Formulaire expérimental ancienne dette : capture puis confirmation sous
 * transactions exclusives ; aucune attribution implicite à la facture du jour. */
import {canonicalJson} from '@sls/domain';
import {availablePriorDebt} from '../../packages/domain/src/day-invoice';
import {getDeviceIdentity,assertDeviceWritable,type DeviceIdentity} from './identified-device';
import {assertLegacyMobileCreditSafe} from './credit-note-write-guard-prototype';
import {captureDayInvoiceForm} from './day-invoice-form';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {readDayInvoiceClients} from './day-invoice-clients';
import {appendOldDebt,readOldDebtOutbox,validateOldDebtEvent,type OldDebtEvent} from './day-invoice-old-debt-queue';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export async function captureOldDebtForm(tx:Tx,identity:DeviceIdentity,clientId:string,day:string,digest:(value:string)=>Promise<string>){
 const bound=await getDeviceIdentity(tx);if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur du téléphone incohérent.');
 await assertLegacyMobileCreditSafe(tx,identity);await assertDeviceWritable(tx,identity,[day]);
 const invoice=await captureDayInvoiceForm(tx,identity,clientId,day,digest);
 const clients=await readDayInvoiceClients(tx,identity,digest);
 const client=clients.clients.find(c=>c.id===clientId);if(!client||client.conflict||client.balance===null)throw Error('Solde client indisponible : rapprochement nécessaire.');
 const unrecognized=invoice.source.preInvoice&&!invoice.source.preInvoice.declared?invoice.source.preInvoice.total:0;
 const available=availablePriorDebt(client.balance,{remaining:invoice.view.remaining,unrecognizedPreInvoice:unrecognized});
 const fingerprint=canonicalJson({clientId,day,balance:client.balance,available,invoice:invoice.fingerprint});
 return {clientId,clientName:client.name,day,balance:client.balance,available,fingerprint};
}
export async function confirmOldDebtForm(tx:Tx,identity:DeviceIdentity,input:{fingerprint:string;event:OldDebtEvent},digest:(value:string)=>Promise<string>){
 validateOldDebtEvent(input.event);
 // En reprise, vérifier la file ou une preuve serveur avant de reconnaître le
 // doublon : une ligne locale seule ne prouve pas que la transmission est sûre.
 const existing=await tx.getFirstAsync<{payload:string}>('SELECT payload FROM day_invoice_old_debt_local WHERE operation_id=?',input.event.event.operationId);
 if(existing){
  const entries=await readOldDebtOutbox(tx,identity),queued=entries.find(e=>e.operationId===input.event.event.operationId);
  if(!queued){const ref=await readDayInvoiceReferenceCache(tx,identity),id=input.event.event.operationId,settlement=input.event.event.settlement;
   const marker=ref?.oldDebtMarkers.find(m=>m.operationId===id),state=ref?.settlementStates?.find(s=>s.operationId===id),proof=ref?.settlementProofs.find(p=>p.operationId===id);
   if(!marker||marker.invoiceDay!==input.event.invoiceDay||state?.clientId!==settlement.clientId||!proof||proof.hash!==await digest(canonicalJson(settlement)))throw Error('Accusé de règlement indisponible : rapprochement nécessaire.');
  }
 }
 return appendOldDebt(tx,identity,input.event,async(locked,event)=>{
  const s=event.event.settlement,current=await captureOldDebtForm(locked,identity,s.clientId,event.invoiceDay,digest);
  const reference=await readDayInvoiceReferenceCache(locked,identity);
  if(!reference||reference.settlementStates?.some(s=>s.operationId===event.event.operationId)||reference.dayPayments.some(p=>p.operationId===event.event.operationId))throw Error('Identifiant de règlement déjà utilisé.');
  if(current.fingerprint!==input.fingerprint)throw Error('Le solde ou la facture a changé : vérifiez à nouveau avant de confirmer.');
  if(s.clientName!==current.clientName)throw Error('Nom du client incohérent.');
  if(s.amount>current.available)throw Error('Règlement supérieur à l’ancienne dette disponible.');
 });
}
