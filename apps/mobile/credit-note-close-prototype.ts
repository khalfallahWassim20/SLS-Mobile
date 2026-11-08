/** Préparation de clôture pour essais uniquement : non utilisée par le mobile.
 * Toute la vérification doit être exécutée dans une transaction SQLite exclusive. */
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {prepareTourClose} from './tour-close-queue';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
export async function preparePrototypeClose(tx:Tx,identity:DeviceIdentity,day:string,expectedVersion:number,uuid:()=>string) {
 const bound=await getDeviceIdentity(tx);
 if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur incohérent.');
 // Conservateur sur tous les jours : aucun avoir en attente ne doit être oublié.
 const pending=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM offline_credit_prototype WHERE pending=1) AS n');
 if(!pending||pending.n)throw Error('Un avoir est en attente : synchronisez ou rapprochez-le avant clôture.');
 return prepareTourClose(tx,identity.commercialId,day,expectedVersion,uuid);
}
