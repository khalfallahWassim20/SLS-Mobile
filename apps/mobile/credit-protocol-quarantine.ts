/** Garde persistante après refus explicite d'un serveur authentifié. Ne pas
 * effacer les opérations : elles doivent être rapprochées avec la version v5. */
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
const uuid=(x:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
export async function quarantineOnUpgrade(tx:Tx,identity:DeviceIdentity,status:number,body:unknown):Promise<boolean>{
 if(status!==409||!body||typeof body!=='object'||Array.isArray(body)||(body as {code?:unknown}).code!=='CREDIT_PROTOCOL_UPGRADE_REQUIRED')return false;
 let origin:string;
 try{const url=new URL(identity.serverOrigin);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error();origin=url.origin;}catch{throw Error('Serveur invalide.');}
 if(!uuid(identity.commercialId)||origin!==identity.serverOrigin)throw Error('Identité invalide.');
 const linked=await getDeviceIdentity(tx);
 if(linked&&(linked.commercialId!==identity.commercialId||linked.serverOrigin!==origin))throw Error('Identité ou serveur différent du téléphone lié.');
 const old=await tx.getFirstAsync<{commercialId:string;serverOrigin:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin FROM credit_protocol_quarantine WHERE id=1');
 if(old&&(old.commercialId!==identity.commercialId||old.serverOrigin!==origin))throw Error('Téléphone déjà bloqué pour une autre identité.');
 await tx.runAsync('INSERT INTO credit_protocol_quarantine(id,commercial_id,server_origin) VALUES(1,?,?) ON CONFLICT(id) DO NOTHING',identity.commercialId,origin);
 return true;
}
