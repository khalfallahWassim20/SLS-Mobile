/** Abandon local uniquement après réservation authentifiée de l'UUID serveur.
 * Appeler chaque fonction dans une transaction SQLite exclusive. */
import {canonicalJson} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import {readAllOfflineCreditPrototype,type Note} from './credit-note-offline-prototype';
import {saveVerifiedCreditReference} from './credit-note-sync-reference';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export async function readPendingCreditAbandonPrototype(tx:Tx,identity:DeviceIdentity,operationId:string):Promise<Note>{
 const found=(await readAllOfflineCreditPrototype(tx,identity)).find(x=>x.note.command.operationId===operationId);
 if(!found||!found.pending)throw Error('Avoir en attente introuvable ou déjà confirmé.');return found.note;
}
export async function resolveCreditAbandonPrototype(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,note:Note,response:unknown,reference:unknown,digest:(text:string)=>Promise<string>){
 if(identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur incohérent.');
 const current=await readPendingCreditAbandonPrototype(tx,identity,note.command.operationId);
 if(canonicalJson(current)!==canonicalJson(note))throw Error('Avoir modifié : abandon refusé.');
 const r=response&&typeof response==='object'&&!Array.isArray(response)?response as Record<string,unknown>:null;
 if(!r||Object.keys(r).sort().join(',')!=='invoiceId,kind,operationId,status'||r.status!=='abandoned'||r.kind!==note.kind||r.operationId!==note.command.operationId||r.invoiceId!==note.command.invoiceId)throw Error('Accusé d’abandon invalide : avoir conservé.');
 await saveVerifiedCreditReference(tx,identity,verified,reference,digest);
 await tx.runAsync('INSERT INTO credit_abandoned_note_prototype(operation_id,commercial_id,server_origin,payload,receipt,abandoned_at) VALUES(?,?,?,?,?,?)',note.command.operationId,identity.commercialId,identity.serverOrigin,canonicalJson(note),canonicalJson(r),new Date().toISOString());
 await tx.runAsync('DELETE FROM offline_credit_prototype WHERE operation_id=? AND pending=1',note.command.operationId);
 await tx.runAsync('DELETE FROM credit_sources_prototype_cache WHERE client_id=?',note.kind==='sale'?(note.source as any).clientId:(note.source as any).invoice.clientId);
}
