/** File expérimentale v6 ; toutes ces fonctions exigent une transaction
 * SQLite exclusive. Elles ne sont pas raccordées au mobile normal. */
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {captureDayInvoiceClose} from './day-invoice-close-capture';
import {findTourCloseAttempt,prepareExperimentalDayInvoiceTourClose,acknowledgeAbandonedTourClose,applyReopenedServerState,type Attempt} from './tour-close-queue';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export const dayInvoiceCloseAttemptSchema=`CREATE TABLE IF NOT EXISTS day_invoice_close_attempt_markers (request_id TEXT PRIMARY KEY, cash_proof TEXT NOT NULL);`;
async function assertBound(tx:Tx,identity:DeviceIdentity){const bound=await getDeviceIdentity(tx);if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur du téléphone incohérent.');}
export async function prepareDayInvoiceCloseAttempt(tx:Tx,identity:DeviceIdentity,day:string,version:number,uuid:()=>string,digest:(value:string)=>Promise<string>):Promise<Attempt>{
 await assertBound(tx,identity);
 const previous=await findTourCloseAttempt(tx,identity.commercialId,day);
 // Toujours recalculer avant une reprise, sans effacer une éventuelle réponse perdue.
 const capture=await captureDayInvoiceClose(tx,identity,day,digest);
 if(previous){
  const marker=await tx.getFirstAsync<{cashProof:string}>('SELECT cash_proof AS cashProof FROM day_invoice_close_attempt_markers WHERE request_id=?',previous.requestId);
  if(previous.status!=='closing'||previous.expectedVersion!==version||previous.adminRefundProof!==undefined||!marker||marker.cashProof!==previous.cashProof||marker.cashProof!==capture.cashProof)throw Error('Tentative de clôture différente ou périmée : réponse ou abandon serveur requis.');
  return previous;
 }
 const attempt=await prepareExperimentalDayInvoiceTourClose(tx,identity.commercialId,day,version,uuid);
 await tx.runAsync('INSERT INTO tour_close_cash_proofs(request_id,hash) VALUES(?,?)',attempt.requestId,capture.cashProof);
 await tx.runAsync('INSERT INTO day_invoice_close_attempt_markers(request_id,cash_proof) VALUES(?,?)',attempt.requestId,capture.cashProof);
 return {...attempt,cashProof:capture.cashProof};
}
export async function abandonDayInvoiceCloseAttempt(tx:Tx,identity:DeviceIdentity,day:string,attempt:Attempt,response:unknown){
 await assertBound(tx,identity);
 const marker=await tx.getFirstAsync<{cashProof:string}>('SELECT cash_proof AS cashProof FROM day_invoice_close_attempt_markers WHERE request_id=?',attempt.requestId);
 if(!marker||marker.cashProof!==attempt.cashProof)throw Error('Preuve de clôture v6 indisponible.');
 await acknowledgeAbandonedTourClose(tx,identity.commercialId,day,attempt,response);
 await tx.runAsync('DELETE FROM day_invoice_close_attempt_markers WHERE request_id=?',attempt.requestId);
}
export async function applyDayInvoiceReopenedState(tx:Tx,identity:DeviceIdentity,day:string,state:unknown){
 await assertBound(tx,identity);
 const attempt=await findTourCloseAttempt(tx,identity.commercialId,day);if(!attempt)return false;
 const marker=await tx.getFirstAsync<{cashProof:string}>('SELECT cash_proof AS cashProof FROM day_invoice_close_attempt_markers WHERE request_id=?',attempt.requestId);
 if(!marker||marker.cashProof!==attempt.cashProof)throw Error('Preuve de clôture v6 indisponible.');
 const applied=await applyReopenedServerState(tx,identity.commercialId,day,state);
 if(applied)await tx.runAsync('DELETE FROM day_invoice_close_attempt_markers WHERE request_id=?',attempt.requestId);
 return applied;
}
