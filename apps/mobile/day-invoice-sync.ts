/** Synchronisation v6 expérimentale. Non raccordée aux écrans ni à l'API
 * normale. Le jeton ne transite que par les fonctions réseau de l'appelant.
 * Chaque transaction doit être exclusive et l'appelant doit vérifier la
 * session, l'origine et sa preuve de serveur avant tout transfert. */
import {canonicalJson} from '@sls/domain';
import {tunisDay} from './journal';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {assertDayInvoiceAttemptsSettled} from './day-invoice-attempt-guard';
import {acquireDayInvoiceSync,releaseDayInvoiceSync} from './day-invoice-sync-lock';
import {readIdentifiedOutbox,acknowledgeIdentifiedOutbox} from './identified-outbox';
import {uploadIdentifiedOperations,type IdentifiedEntry} from './identified-upload';
import {readDayInvoiceOutbox,acknowledgeDayInvoicePayment} from './day-invoice-queue';
import {uploadDayInvoicePayments,validateDayInvoiceQueue} from './day-invoice-upload';
import {assertLegacyMobileCreditSafe} from './credit-note-write-guard-prototype';
import {readOldDebtOutbox,acknowledgeOldDebt} from './day-invoice-old-debt-queue';
import {uploadOldDebts} from './day-invoice-old-debt-upload';
import {saveDayInvoiceReference} from './day-invoice-reference-cache';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
type IO={
 transaction:<T>(work:(tx:Tx)=>Promise<T>)=>Promise<T>;
 /** Doit revalider l'identité liée et la preuve serveur authentifiée. */
 verifyServer:(identity:DeviceIdentity,check:()=>void)=>Promise<void>;
 fetchReference:()=>Promise<unknown>;
 digest:(text:string)=>Promise<string>;
 sendSource:(path:string,payload:string)=>Promise<Response>;
 sendPayment:(payload:string)=>Promise<Response>;
 sendOldDebt?:(payload:string)=>Promise<Response>;
 /** Doit lever si session expirée, révoquée ou changée. */
 check:()=>void;
};
export async function synchronizeDayInvoicePrototype(identity:DeviceIdentity,verified:DeviceIdentity,io:IO){
 acquireDayInvoiceSync();
 try{
  const check=io.check;check();
  if(identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur différent du téléphone lié.');
  const capture=()=>io.transaction(async tx=>{check();const bound=await getDeviceIdentity(tx);if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin)throw Error('Identité du téléphone modifiée.');
   await assertLegacyMobileCreditSafe(tx,identity);await assertDayInvoiceAttemptsSettled(tx,identity);
   const sources=await readIdentifiedOutbox(tx,identity),payments=await readDayInvoiceOutbox(tx,identity),debts=await readOldDebtOutbox(tx,identity);validateDayInvoiceQueue(payments,identity,verified);
   const ids=new Set(sources.map(s=>s.operationId));if(ids.size!==sources.length||payments.some(p=>ids.has(p.operationId))||debts.some(p=>ids.has(p.operationId)||payments.some(x=>x.operationId===p.operationId)))throw Error('Identifiant d’opération dupliqué entre files.');check();return {sources,payments,debts};});
  const refresh=async()=>{check();const reference=await io.fetchReference();check();await io.transaction(async tx=>{check();await saveDayInvoiceReference(tx,identity,verified,reference);check();});};
  await io.verifyServer(identity,check);check();
  // Vérifier les deux files avant le premier envoi. Des sources sont envoyées
  // avant les règlements qui en dépendent ; aucun accusé ne supprime l'historique.
  const captured=await capture();await refresh();
  const sourcesById=new Map(captured.sources.map(e=>[e.operationId,e]));
  const sourceCount=await uploadIdentifiedOperations(captured.sources,identity,verified,async(path,payload)=>{check();const response=await io.sendSource(path,payload);check();return {ok:response.ok,status:response.status,json:async()=>{check();const value=await response.json();check();return value;}};},
   async(operationId,kind)=>{const entry=sourcesById.get(operationId);if(!entry||entry.kind!==kind)throw Error('Accusé de source incohérent.');
    check();const reference=await io.fetchReference();check();await io.transaction(async tx=>{
     check();await saveDayInvoiceReference(tx,identity,verified,reference);const ref=await readDayInvoiceReferenceCache(tx,identity),event=JSON.parse(entry.payload);
     if(!ref)throw Error('Référence de source indisponible : opération conservée.');
     if(entry.kind==='sale'){
      // La référence ne contient pas le détail de vente : l'accusé exact et
      // les marqueurs vérifient la version et les montants, pas chaque ligne.
      const sale=event.sale,state=ref.saleStates?.find(s=>s.saleId===entry.entityId),dated=ref.saleDays.find(s=>s.saleId===entry.entityId);
      if(!sale||!state||state.clientId!==sale.clientId||state.version!==event.version||state.total!==String(sale.total)||state.paid!==String(sale.paid)||dated?.clientId!==sale.clientId||dated?.day!==tunisDay(new Date(sale.createdAt)))throw Error('Marqueur serveur de vente incohérent : opération conservée.');
     }else if(entry.kind==='journal'){
      const proof=ref.journalProofs.find(p=>p.id===entry.entityId),state=ref.journalStates?.find(s=>s.id===entry.entityId);
      if(!event.invoice||!state||state.clientId!==event.invoice.clientId||state.journalDate!==event.invoice.journalDate||!proof||proof.version!==event.version||proof.hash!==await io.digest(canonicalJson(event)))throw Error('Preuve serveur du journal incohérente : opération conservée.');
     }else{
      const settlement=event.settlement,state=ref.settlementStates?.find(s=>s.operationId===operationId),proof=ref.settlementProofs.find(p=>p.operationId===operationId);
      if(!settlement||state?.clientId!==settlement.clientId||!proof||proof.hash!==await io.digest(canonicalJson(settlement)))throw Error('Preuve serveur du règlement incohérente : opération conservée.');
     }
     check();await acknowledgeIdentifiedOutbox(tx,identity,entry as IdentifiedEntry);check();
    });});
  // Les sources reçues peuvent avoir modifié la facture depuis la première
  // capture. Le serveur vérifie à nouveau toutes les versions lors du paiement.
  await refresh();
  if(captured.debts.length&&!io.sendOldDebt)throw Error('Transport ancienne dette indisponible.');
  const debtCount=await uploadOldDebts(captured.debts,identity,verified,async payload=>{check();const response=await io.sendOldDebt!(payload);check();return {ok:response.ok,status:response.status,json:async()=>{check();const value=await response.json();check();return value;}};},
   async entry=>{check();const reference=await io.fetchReference();check();await io.transaction(async tx=>{
    check();await saveDayInvoiceReference(tx,identity,verified,reference);
    const ref=await readDayInvoiceReferenceCache(tx,identity),event=JSON.parse(entry.payload),settlement=event.event.settlement;
    const marker=ref?.oldDebtMarkers.find(m=>m.operationId===entry.operationId),state=ref?.settlementStates?.find(s=>s.operationId===entry.operationId),proof=ref?.settlementProofs.find(p=>p.operationId===entry.operationId);
    if(!marker||marker.invoiceDay!==event.invoiceDay||state?.clientId!==settlement.clientId||!proof||proof.hash!==await io.digest(canonicalJson(settlement)))throw Error('Preuve serveur du règlement ancienne dette indisponible : opération conservée.');
    check();await acknowledgeOldDebt(tx,identity,entry);check();
   });});
  if(debtCount)await refresh();
  const paymentCount=await uploadDayInvoicePayments(captured.payments,identity,verified,async(payload)=>{check();const response=await io.sendPayment(payload);check();return {ok:response.ok,status:response.status,json:async()=>{check();const value=await response.json();check();return value;}};},
   async entry=>{check();const reference=await io.fetchReference();check();await io.transaction(async tx=>{
    check();await saveDayInvoiceReference(tx,identity,verified,reference);const ref=await readDayInvoiceReferenceCache(tx,identity),payment=ref?.dayPayments.find(p=>p.operationId===entry.operationId);
    if(!payment||canonicalJson(payment)!==canonicalJson(JSON.parse(entry.payload)))throw Error('Preuve serveur du paiement indisponible : opération conservée.');
    check();await acknowledgeDayInvoicePayment(tx,entry);check();
   });});
  await refresh();const remaining=await capture();check();
  return {sources:sourceCount+debtCount,payments:paymentCount,remainingSources:remaining.sources.length+remaining.debts.length,remainingPayments:remaining.payments.length};
 }finally{releaseDayInvoiceSync();}
}
