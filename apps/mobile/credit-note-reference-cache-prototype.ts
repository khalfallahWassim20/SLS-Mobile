/** Cache expérimental : inutilisé par les écrans et la synchronisation active.
 * Utiliser une transaction SQLite exclusive et une réponse authentifiée. */
import {canonicalJson} from '@sls/domain';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {validatePrototypeCreditReference} from './credit-note-reference-prototype';
type Tx={getFirstAsync<T>(sql:string,...params:(string|number|null)[]):Promise<T|null>;runAsync(sql:string,...params:(string|number|null)[]):Promise<unknown>};
export const creditReferencePrototypeSchema=`CREATE TABLE IF NOT EXISTS credit_reference_prototype_cache (
 id INTEGER PRIMARY KEY CHECK(id=1),commercial_id TEXT NOT NULL,server_origin TEXT NOT NULL,payload TEXT NOT NULL
);`;
async function checkIdentity(tx:Tx,id:DeviceIdentity) {
 const bound=await getDeviceIdentity(tx);
 if(!bound||bound.commercialId!==id.commercialId||bound.serverOrigin!==id.serverOrigin)throw Error('Identité ou serveur incohérent.');
}
/** Un ancien accusé ou une réponse périmée ne peut effacer un avoir confirmé. */
export async function savePrototypeCreditReference(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,value:unknown):Promise<void> {
 await checkIdentity(tx,identity);
 if(identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur incohérent.');
 const next=validatePrototypeCreditReference(value);
 const previous=await tx.getFirstAsync<{commercialId:string;serverOrigin:string;payload:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM credit_reference_prototype_cache WHERE id=1');
 if(previous) {
  if(previous.commercialId!==identity.commercialId||previous.serverOrigin!==identity.serverOrigin)throw Error('Cache lié à une autre identité.');
  const old=validatePrototypeCreditReference(JSON.parse(previous.payload));
  const nextSales=new Map(next.saleStates.map(s=>[s.saleId,s]));
  for(const sale of old.saleStates) {
   const updated=nextSales.get(sale.saleId);
   if(!updated||updated.clientId!==sale.clientId||updated.version<sale.version||(updated.version===sale.version&&canonicalJson(updated)!==canonicalJson(sale))|| (sale.creditNote&&(!updated.creditNote||canonicalJson(updated.creditNote)!==canonicalJson(sale.creditNote))))throw Error('Référence de vente périmée ou incohérente.');
  }
  const nextSaleProofs=new Map(next.saleProofs.map(p=>[p.saleId,p]));
  for(const p of old.saleProofs)if(canonicalJson(nextSaleProofs.get(p.saleId))!==canonicalJson(p))throw Error('Preuve de vente périmée ou incohérente.');
  const nextJournals=new Map(next.journalStates.map(s=>[s.id,s]));
  for(const journal of old.journalStates) {
   const updated=nextJournals.get(journal.id);
   if(!updated||updated.clientId!==journal.clientId||updated.journalDate!==journal.journalDate||updated.total!==journal.total||updated.version<journal.version||updated.version-journal.version!==updated.receipts.length-journal.receipts.length||journal.receipts.some((r,i)=>canonicalJson(r)!==canonicalJson(updated.receipts[i]))|| (journal.creditNote&&(!updated.creditNote||canonicalJson(updated.creditNote)!==canonicalJson(journal.creditNote))))throw Error('Référence du journal périmée ou incohérente.');
  }
  const settlements=new Map(next.settlementStates?.map(s=>[s.operationId,s.clientId])??[]);
  if(old.settlementStates?.some(s=>settlements.get(s.operationId)!==s.clientId))throw Error('Référence des règlements périmée.');
 }
 await tx.runAsync(`INSERT INTO credit_reference_prototype_cache(id,commercial_id,server_origin,payload) VALUES(1,?,?,?)
 ON CONFLICT(id) DO UPDATE SET commercial_id=excluded.commercial_id,server_origin=excluded.server_origin,payload=excluded.payload`,identity.commercialId,identity.serverOrigin,JSON.stringify(next));
}
export async function readPrototypeCreditReferenceCache(tx:Tx,identity:DeviceIdentity) {
 await checkIdentity(tx,identity);
 const row=await tx.getFirstAsync<{commercialId:string;serverOrigin:string;payload:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM credit_reference_prototype_cache WHERE id=1');
 if(!row)return null;
 if(row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin)throw Error('Cache lié à une autre identité.');
 return validatePrototypeCreditReference(JSON.parse(row.payload));
}
