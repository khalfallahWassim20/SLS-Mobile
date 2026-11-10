/** Préparation du mode individuel ; n'enregistre ni mot de passe ni jeton. */
import {canonicalJson} from '@sls/domain';
import {assertLocalTourWritable} from './tour-close-queue';
import {validateIdentifiedReference} from './identified-reference';
import {validatePrototypeCreditReference} from './credit-note-reference-prototype';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
export type DeviceIdentity={commercialId:string;serverOrigin:string};
export const identifiedDeviceSchema=`CREATE TABLE IF NOT EXISTS identified_device (
 id INTEGER PRIMARY KEY CHECK(id=1), commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS identified_local_operations (
 operation_id TEXT PRIMARY KEY, commercial_id TEXT NOT NULL, operation_kind TEXT NOT NULL CHECK(operation_kind IN ('sale','settlement','journal')),
 entity_id TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS identified_reference_cache (
 id INTEGER PRIMARY KEY CHECK(id=1), commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL, payload TEXT NOT NULL
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
export async function assertKnownDeviceEntity(tx:Tx,identity:DeviceIdentity|null,kind:'sale'|'journal',entityId:string|undefined,previousSale?:{clientId:string;version:number;total:number;paid:number;payload?:string;digest?:(text:string)=>Promise<string>},previousJournal?:{version:number;payload:string;digest:(text:string)=>Promise<string>},creditAware=false):Promise<void> {
 if(!identity)return;
 if(!entityId)throw Error('Ancienne opération sans identité : rapprochement nécessaire.');
 const row=await tx.getFirstAsync<{commercialId:string}>('SELECT commercial_id AS commercialId FROM identified_local_operations WHERE operation_kind=? AND entity_id=? LIMIT 1',kind,entityId);
 if(row){if(row.commercialId!==identity.commercialId)throw Error('Ancienne opération liée à un autre commercial : rapprochement nécessaire.');return;}
 if(creditAware) {
  // En v5, ne jamais retomber sur une ancienne preuve v3 : elle pourrait
  // ignorer une annulation ou une modification reçue d'un autre appareil.
  const cache=await tx.getFirstAsync<{commercialId:string;serverOrigin:string;payload:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM credit_reference_prototype_cache WHERE id=1');
  if(cache && cache.commercialId===identity.commercialId && cache.serverOrigin===identity.serverOrigin) {
   try {
    const reference=validatePrototypeCreditReference(JSON.parse(cache.payload));
    if(kind==='sale'&&previousSale?.payload&&previousSale.digest) {
     const state=reference.saleStates.find(s=>s.saleId===entityId),proof=reference.eligibleSaleProofs.find(p=>p.saleId===entityId),source=JSON.parse(previousSale.payload);
     if(state&&!state.creditNote&&state.clientId===previousSale.clientId&&state.version===previousSale.version&&state.total===String(previousSale.total)&&state.paid===String(previousSale.paid)&&proof?.version===state.version&&source.syncSaleId===entityId&&source.syncVersion===state.version&&await previousSale.digest(canonicalJson(source))===proof.hash)return;
    }
    if(kind==='journal'&&previousJournal) {
     const state=reference.journalStates.find(s=>s.id===entityId),proof=reference.journalProofs.find(p=>p.id===entityId),snapshot=JSON.parse(previousJournal.payload);
     if(state&&!state.creditNote&&reference.eligibleJournalIds.includes(entityId!)&&proof?.version===previousJournal.version&&snapshot?.version===proof.version&&snapshot?.invoice?.id===entityId&&await previousJournal.digest(canonicalJson(snapshot))===proof.hash)return;
    }
   } catch { /* cache incomplet, source modifiée ou preuve illisible : refus prudent */ }
  }
  throw Error('Ancienne opération sans version serveur v5 confirmée : rapprochement nécessaire.');
 }
 if(kind==='sale' && previousSale) {
  const cache=await tx.getFirstAsync<{commercialId:string;serverOrigin:string;payload:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM identified_reference_cache WHERE id=1');
  if(cache && cache.commercialId===identity.commercialId && cache.serverOrigin===identity.serverOrigin) {
   try {const reference=validateIdentifiedReference(JSON.parse(cache.payload));
    const state=reference.saleStates?.find(s=>s.saleId===entityId);
    if(state && state.clientId===previousSale.clientId && state.version===previousSale.version && state.total===String(previousSale.total) && state.paid===String(previousSale.paid))return;
   } catch { /* cache incomplet ou illisible : échec prudent */ }
  }
 }
 if(kind==='journal' && previousJournal) {
  const cache=await tx.getFirstAsync<{commercialId:string;serverOrigin:string;payload:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM identified_reference_cache WHERE id=1');
  if(cache && cache.commercialId===identity.commercialId && cache.serverOrigin===identity.serverOrigin) {
   try {
    const reference=validateIdentifiedReference(JSON.parse(cache.payload));
    const proof=reference.journalProofs.find(p=>p.id===entityId);
    const snapshot=JSON.parse(previousJournal.payload);
    if(proof && proof.version===previousJournal.version && snapshot?.version===proof.version && snapshot?.invoice?.id===entityId && await previousJournal.digest(canonicalJson(snapshot))===proof.hash)return;
   } catch { /* aucune preuve fiable : échec prudent */ }
  }
 }
 throw Error('Ancienne opération sans version serveur confirmée : rapprochement nécessaire.');
}
/** L'appelant doit avoir vérifié la session auprès du serveur avant de sauvegarder cet instantané. */
export async function saveVerifiedIdentifiedReference(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,value:unknown):Promise<void> {
 const bound=await getDeviceIdentity(tx);
 if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin||verified.commercialId!==identity.commercialId||verified.serverOrigin!==identity.serverOrigin)throw Error('Session ou serveur différent du téléphone lié.');
 const parsed=validateIdentifiedReference(value);
 await tx.runAsync('INSERT INTO identified_reference_cache(id,commercial_id,server_origin,payload) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET commercial_id=excluded.commercial_id,server_origin=excluded.server_origin,payload=excluded.payload',identity.commercialId,identity.serverOrigin,JSON.stringify(parsed));
}
