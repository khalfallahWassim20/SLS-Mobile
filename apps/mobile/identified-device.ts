/** Préparation du mode individuel ; n'enregistre ni mot de passe ni jeton. */
import {assertLocalTourWritable} from './tour-close-queue';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
export type DeviceIdentity={commercialId:string;serverOrigin:string};
export const identifiedDeviceSchema=`CREATE TABLE IF NOT EXISTS identified_device (
 id INTEGER PRIMARY KEY CHECK(id=1), commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS identified_local_operations (
 operation_id TEXT PRIMARY KEY, commercial_id TEXT NOT NULL, operation_kind TEXT NOT NULL CHECK(operation_kind IN ('sale','settlement','journal')),
 entity_id TEXT NOT NULL, recorded_at TEXT NOT NULL
);`;
const uuid=(v:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export async function getDeviceIdentity(tx:Tx):Promise<DeviceIdentity|null> {
 return tx.getFirstAsync<DeviceIdentity>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin FROM identified_device WHERE id=1');
}
/** L'identité doit provenir d'une session vérifiée en ligne, jamais d'un nom saisi localement.
 * À appeler dans une transaction exclusive après vérification de l'identité et du serveur. */
export async function bindVerifiedDevice(tx:Tx,identity:DeviceIdentity):Promise<void> {
 let origin:string;
 try {const url=new URL(identity.serverOrigin);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error();origin=url.origin;}catch{throw Error('Adresse serveur invalide.');}
 if(!uuid(identity.commercialId))throw Error('Identité commerciale invalide.');
 const old=await getDeviceIdentity(tx);
 if(old){if(old.commercialId!==identity.commercialId||old.serverOrigin!==origin)throw Error('Ce téléphone est déjà lié à un autre commercial ou serveur : rapprochement requis.');return;}
 const pending=await tx.getFirstAsync<{pending:number}>(`SELECT EXISTS(SELECT 1 FROM sales_outbox) OR EXISTS(SELECT 1 FROM journal_sync_outbox)
 OR EXISTS(SELECT 1 FROM tour_pre_invoices p LEFT JOIN journal_sync_state s ON s.invoice_id=p.id WHERE s.invoice_id IS NULL) AS pending`);
 if(!pending||pending.pending)throw Error('Synchronisez ou rapprochez les opérations en attente avant de lier ce téléphone.');
 await tx.runAsync('INSERT INTO identified_device(id,commercial_id,server_origin) VALUES(1,?,?)',identity.commercialId,origin);
}
export async function assertDeviceWritable(tx:Tx,identity:DeviceIdentity|null,days:string[]):Promise<void> {
 if(identity)for(const day of [...new Set(days)].sort())await assertLocalTourWritable(tx,identity.commercialId,day);
}
export async function recordDeviceOperation(tx:Tx,identity:DeviceIdentity|null,operationId:string,kind:'sale'|'settlement'|'journal',entityId:string,recordedAt:string):Promise<void> {
 if(!identity)return;
 if(!uuid(operationId)||!uuid(entityId)||!Number.isFinite(Date.parse(recordedAt)))throw Error('Métadonnées de synchronisation invalides.');
 await tx.runAsync('INSERT INTO identified_local_operations(operation_id,commercial_id,operation_kind,entity_id,recorded_at) VALUES(?,?,?,?,?)',operationId,identity.commercialId,kind,entityId,recordedAt);
}
/** Ne jamais réattribuer silencieusement une ancienne vente ou facture à la nouvelle identité. */
export async function assertKnownDeviceEntity(tx:Tx,identity:DeviceIdentity|null,kind:'sale'|'journal',entityId:string|undefined):Promise<void> {
 if(!identity)return;
 if(!entityId)throw Error('Ancienne opération sans identité : rapprochement nécessaire.');
 const row=await tx.getFirstAsync<{commercialId:string}>('SELECT commercial_id AS commercialId FROM identified_local_operations WHERE operation_kind=? AND entity_id=? LIMIT 1',kind,entityId);
 if(!row||row.commercialId!==identity.commercialId)throw Error('Ancienne opération sans identité confirmée : rapprochement nécessaire.');
}
