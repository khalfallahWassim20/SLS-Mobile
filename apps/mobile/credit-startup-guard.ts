import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {readPrototypeCreditReferenceCache} from './credit-note-reference-cache-prototype';
import {assertLegacyMobileCreditSafe} from './credit-note-write-guard-prototype';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};

/** Lecture atomique sous transaction exclusive. Une identité perdue ne doit
 * jamais masquer un cache, un avoir ou une quarantaine v5 orphelins. Toute
 * erreur est propagée : elle ne signifie pas « pas encore migré ». */
export async function inspectCreditStartup(tx:Tx,enabled:boolean):Promise<{identity:DeviceIdentity|null;ready:boolean;quarantined:boolean}>{
 const identity=await getDeviceIdentity(tx);
 if(!enabled)return {identity,ready:false,quarantined:false};
 if(!identity){await assertLegacyMobileCreditSafe(tx,null);return {identity:null,ready:false,quarantined:false};}
 const quarantine=await tx.getFirstAsync<{commercialId:string;serverOrigin:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin FROM credit_protocol_quarantine WHERE id=1');
 if(quarantine&&(quarantine.commercialId!==identity.commercialId||quarantine.serverOrigin!==identity.serverOrigin))throw Error('Quarantaine liée à une autre identité.');
 return {identity,ready:!!(await readPrototypeCreditReferenceCache(tx,identity)),quarantined:!!quarantine};
}
