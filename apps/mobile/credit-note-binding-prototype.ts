/** Liaison v5 isolée : le serveur et le compte ont été vérifiés en ligne par
 * l'appelant ; la liaison et le cache doivent être committés ensemble. */
import {bindVerifiedDevice,type DeviceIdentity} from './identified-device';
import {saveVerifiedCreditReference} from './credit-note-sync-reference';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
export async function bindAndCacheCreditReferencePrototype(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,value:unknown,digest:(text:string)=>Promise<string>,guard:()=>void){
 guard();
 if(identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur différent du téléphone.');
 await bindVerifiedDevice(tx,verified);guard();
 // Une première migration d'un téléphone déjà lié ne doit pas croiser un
 // envoi v3 en cours. Une reconnexion v5 conserve au contraire ses files.
 const existing=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM credit_reference_prototype_cache) AS n');
 if(!existing)throw Error('État de migration v5 indisponible.');
 if(!existing.n){
  const pending=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM sales_outbox) OR EXISTS(SELECT 1 FROM journal_sync_outbox)
   OR EXISTS(SELECT 1 FROM tour_pre_invoices p LEFT JOIN journal_sync_state s ON s.invoice_id=p.id WHERE s.invoice_id IS NULL) AS n`);
  if(!pending||pending.n)throw Error('Synchronisez ou rapprochez les opérations en attente avant la migration v5.');
 }
 guard();await saveVerifiedCreditReference(tx,identity,verified,value,digest);guard();
}
