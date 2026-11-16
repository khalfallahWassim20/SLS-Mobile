/** Synchronisation v6 expérimentale. Non raccordée aux écrans ni à l'API
 * normale. Le jeton ne transite que par les fonctions réseau de l'appelant.
 * Chaque transaction doit être exclusive et l'appelant doit vérifier la
 * session, l'origine et sa preuve de serveur avant tout transfert. */
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
   async(operationId,kind)=>{const entry=sourcesById.get(operationId);if(!entry||entry.kind!==kind)throw Error('Accusé de source incohérent.');await io.transaction(async tx=>{check();await acknowledgeIdentifiedOutbox(tx,identity,entry as IdentifiedEntry);check();});});
  // Les sources reçues peuvent avoir modifié la facture depuis la première
  // capture. Le serveur vérifie à nouveau toutes les versions lors du paiement.
  await refresh();
  if(captured.debts.length&&!io.sendOldDebt)throw Error('Transport ancienne dette indisponible.');
  const debtCount=await uploadOldDebts(captured.debts,identity,verified,async payload=>{check();const response=await io.sendOldDebt!(payload);check();return {ok:response.ok,status:response.status,json:async()=>{check();const value=await response.json();check();return value;}};},
   async entry=>io.transaction(async tx=>{check();await acknowledgeOldDebt(tx,identity,entry);check();}));
  if(debtCount)await refresh();
  const paymentCount=await uploadDayInvoicePayments(captured.payments,identity,verified,async(payload)=>{check();const response=await io.sendPayment(payload);check();return {ok:response.ok,status:response.status,json:async()=>{check();const value=await response.json();check();return value;}};},
   async(entry)=>io.transaction(async tx=>{check();const bound=await getDeviceIdentity(tx);if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin)throw Error('Identité du téléphone modifiée.');await acknowledgeDayInvoicePayment(tx,entry);check();}));
  await refresh();const remaining=await capture();check();
  return {sources:sourceCount+debtCount,payments:paymentCount,remainingSources:remaining.sources.length+remaining.debts.length,remainingPayments:remaining.payments.length};
 }finally{releaseDayInvoiceSync();}
}
