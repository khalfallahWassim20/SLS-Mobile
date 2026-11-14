import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {readPrototypeCreditReferenceCache} from './credit-note-reference-cache-prototype';
import {assertLegacyMobileCreditSafe} from './credit-note-write-guard-prototype';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};

/** Lecture atomique sous transaction exclusive. Une identité perdue ne doit
 * jamais masquer un cache, un avoir ou une quarantaine v5 orphelins. Toute
 * erreur est propagée : elle ne signifie pas « pas encore migré ». */
export async function inspectCreditStartup(tx:Tx,enabled:boolean):Promise<{identity:DeviceIdentity|null;ready:boolean}>{
 const identity=await getDeviceIdentity(tx);
 if(!enabled)return {identity,ready:false};
 if(!identity){await assertLegacyMobileCreditSafe(tx,null);return {identity:null,ready:false};}
 return {identity,ready:!!(await readPrototypeCreditReferenceCache(tx,identity))};
}
