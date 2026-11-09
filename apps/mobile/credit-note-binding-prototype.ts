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
 await saveVerifiedCreditReference(tx,identity,verified,value,digest);guard();
}
