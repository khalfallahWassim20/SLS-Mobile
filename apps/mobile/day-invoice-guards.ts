/** Gardes SQLite du règlement unifié. Elles ne sont pas encore branchées aux écrans. */
import {getDeviceIdentity,assertDeviceWritable,assertKnownDeviceEntity,type DeviceIdentity} from './identified-device';
import {assertLegacyMobileCreditSafe} from './credit-note-write-guard-prototype';
import {assertNoLocalCreditNote,assertNoRemoteCreditNote} from './credit-note-local-guard';
import {tunisDay} from './journal';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import type {DayInvoicePayment} from '../../packages/domain/src/day-invoice';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
/** La transaction exclusive doit rester ouverte jusqu'à l'insertion de la file. */
export async function guardDayInvoiceWrite(tx:Tx,identity:DeviceIdentity,payment:DayInvoicePayment,digest:(value:string)=>Promise<string>,allowRemoteSources=false):Promise<void> {
 const bound=await getDeviceIdentity(tx);
 if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur du téléphone incohérent.');
 await assertLegacyMobileCreditSafe(tx,identity);
 await assertDeviceWritable(tx,identity,[payment.day,tunisDay(new Date(payment.recordedAt))]);
 const taken=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM identified_local_operations WHERE operation_id=?) OR EXISTS(SELECT 1 FROM sales_outbox WHERE operation_id=?) OR EXISTS(SELECT 1 FROM journal_sync_outbox WHERE operation_id=?) OR EXISTS(SELECT 1 FROM offline_credit_prototype WHERE operation_id=?) OR EXISTS(SELECT 1 FROM day_invoice_old_debt_local WHERE operation_id=?) AS n`,payment.operationId,payment.operationId,payment.operationId,payment.operationId,payment.operationId);
 if(!taken||taken.n)throw Error('Identifiant d’opération déjà utilisé.');
 if(payment.preInvoice){
  await assertNoLocalCreditNote(tx,'preinvoice',payment.preInvoice.id);await assertNoRemoteCreditNote(tx,identity,'preinvoice',payment.preInvoice.id);
  const state=await tx.getFirstAsync<{version:number;payload:string}>('SELECT version,payload FROM journal_sync_state WHERE invoice_id=?',payment.preInvoice.id);
  if(state){
   if(state.version!==payment.preInvoice.version)throw Error('Version de facture locale modifiée.');
   await assertKnownDeviceEntity(tx,identity,'journal',payment.preInvoice.id,undefined,{...state,digest});
  }else{
   if(!allowRemoteSources)throw Error('Version de facture locale modifiée.');
   const ref=await readDayInvoiceReferenceCache(tx,identity),source=ref?.journalStates?.find(p=>p.id===payment.preInvoice!.id),proof=ref?.journalProofs.find(p=>p.id===payment.preInvoice!.id);
   if(!source||!proof||source.clientId!==payment.clientId||source.journalDate!==payment.day||source.total!==payment.preInvoice.total||proof.version!==payment.preInvoice.version)throw Error('Preuve de facture distante indisponible ou modifiée.');
  }
 }
 const rows=await tx.getAllAsync<{payload:string}>('SELECT payload FROM sales WHERE client_id=?',payment.clientId);
 const sales=rows.map(row=>({payload:row.payload,value:JSON.parse(row.payload)}));
 for(const proof of payment.sales){
  await assertNoLocalCreditNote(tx,'sale',proof.id);await assertNoRemoteCreditNote(tx,identity,'sale',proof.id);
  const found=sales.filter(row=>row.value.syncSaleId===proof.id);
  if(found.length>1)throw Error('Vente locale dupliquée.');
  if(found.length===1){
   if(found[0].value.syncVersion!==proof.version)throw Error('Version de vente locale modifiée.');
   const sale=found[0].value;
   await assertKnownDeviceEntity(tx,identity,'sale',proof.id,{clientId:payment.clientId,version:proof.version,total:sale.total,paid:sale.paid,payload:found[0].payload,digest});
  }else{
   if(!allowRemoteSources)throw Error('Version de vente locale modifiée.');
   const ref=await readDayInvoiceReferenceCache(tx,identity),source=ref?.saleStates?.find(s=>s.saleId===proof.id),dated=ref?.saleDays.find(s=>s.saleId===proof.id);
   if(!source||!dated||source.clientId!==payment.clientId||dated.clientId!==payment.clientId||dated.day!==payment.day||source.version!==proof.version)throw Error('Preuve de vente distante indisponible ou modifiée.');
  }
 }
}
