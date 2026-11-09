/** Validation finale expérimentale : l'appelant fournit une transaction SQLite
 * exclusive et annule intégralement la transaction si une vérification échoue. */
import type {DeviceIdentity} from './identified-device';
import {readIdentifiedOutbox} from './identified-outbox';
import {readAllOfflineCreditPrototype} from './credit-note-offline-prototype';
import {saveVerifiedCreditReference} from './credit-note-sync-reference';
import {readPrototypeCreditBalance} from './credit-note-balance-storage-prototype';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
/** La dernière référence et tous les soldes locaux sont vérifiés ensemble :
 * une opération arrivée pendant la synchronisation ou une annulation distante
 * incompatible empêche d'annoncer une synchronisation complète. */
export async function saveAndVerifyFinalCreditReference(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,value:unknown,digest:(data:string)=>Promise<string>) {
 await saveVerifiedCreditReference(tx,identity,verified,value,digest);
 if((await readIdentifiedOutbox(tx,identity)).length)throw Error('Une opération reste en attente : synchronisation incomplète.');
 if((await readAllOfflineCreditPrototype(tx,identity)).some(n=>n.pending))throw Error('Un avoir reste en attente : synchronisation incomplète.');
 const clients=await tx.getAllAsync<{clientId:string}>(`SELECT client_id AS clientId FROM sales UNION SELECT client_id AS clientId FROM settlements UNION SELECT client_id AS clientId FROM tour_pre_invoices`);
 for(const {clientId} of clients){
  const balance=await readPrototypeCreditBalance(tx,identity,clientId,digest);
  if(balance.conflict)throw Error('Solde client en conflit : rapprochement nécessaire avant de terminer la synchronisation.');
 }
}
