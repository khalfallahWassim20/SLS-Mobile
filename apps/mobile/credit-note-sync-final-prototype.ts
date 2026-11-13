/** Validation finale expérimentale : l'appelant fournit une transaction SQLite
 * exclusive et annule intégralement la transaction si une vérification échoue. */
import type {DeviceIdentity} from './identified-device';
import {readIdentifiedOutbox} from './identified-outbox';
import {readAllOfflineCreditPrototype} from './credit-note-offline-prototype';
import {saveVerifiedCreditReference} from './credit-note-sync-reference';
import {loadCreditBalanceSnapshotPrototype} from './credit-note-balance-storage-prototype';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
/** La dernière référence et tous les soldes locaux sont vérifiés ensemble :
 * une opération arrivée pendant la synchronisation ou une annulation distante
 * incompatible empêche d'annoncer une synchronisation complète. */
export async function saveAndVerifyFinalCreditReference(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,value:unknown,digest:(data:string)=>Promise<string>) {
 await saveVerifiedCreditReference(tx,identity,verified,value,digest);
 // Une révision distante peut être confirmée après le contrôle initial de la
 // synchronisation. La dernière vérification doit être atomique avec le cache,
 // y compris lorsque ce client n'a aucune facture dans les tables locales.
 const remote=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM credit_remote_sale_confirm_prototype WHERE acknowledged<2) AS n');
 if(!remote||remote.n)throw Error('Une modification distante reste en attente : synchronisation incomplète.');
 if((await readIdentifiedOutbox(tx,identity)).length)throw Error('Une opération reste en attente : synchronisation incomplète.');
 const notes=await readAllOfflineCreditPrototype(tx,identity);
 if(notes.some(n=>n.pending))throw Error('Un avoir reste en attente : synchronisation incomplète.');
 const clients=await tx.getAllAsync<{clientId:string}>(`SELECT client_id AS clientId FROM sales UNION SELECT client_id AS clientId FROM settlements UNION SELECT client_id AS clientId FROM tour_pre_invoices`);
 const clientIds=new Set(clients.map(x=>x.clientId));
 for(const {note} of notes){const source=note.source as {clientId?:unknown;invoice?:{clientId?:unknown}},id=note.kind==='sale'?source.clientId:source.invoice?.clientId;if(typeof id!=='string')throw Error('Client de l’avoir indisponible.');clientIds.add(id);}
 const snapshot=await loadCreditBalanceSnapshotPrototype(tx,identity,digest);
 for(const clientId of clientIds){
  const balance=snapshot.balanceFor(clientId);
  if(balance.conflict)throw Error('Solde client en conflit : rapprochement nécessaire avant de terminer la synchronisation.');
 }
}
