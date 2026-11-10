/** Cache expérimental : inutilisé par les écrans et la synchronisation active.
 * Utiliser une transaction SQLite exclusive et une réponse authentifiée. */
import {remoteSaleDraftPrototypeSchema,remoteSaleConfirmPrototypeSchema} from './credit-remote-sale-schema-prototype';
import {canonicalJson} from '@sls/domain';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {validatePrototypeCreditReference} from './credit-note-reference-prototype';
type Tx={getFirstAsync<T>(sql:string,...params:(string|number|null)[]):Promise<T|null>;runAsync(sql:string,...params:(string|number|null)[]):Promise<unknown>};
export const creditReferencePrototypeSchema=`CREATE TABLE IF NOT EXISTS credit_reference_prototype_cache (
 id INTEGER PRIMARY KEY CHECK(id=1),commercial_id TEXT NOT NULL,server_origin TEXT NOT NULL,payload TEXT NOT NULL
); ${remoteSaleDraftPrototypeSchema} ${remoteSaleConfirmPrototypeSchema}`;
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
  const nextClients=new Map(next.clients.map(c=>[c.id,c]));
  for(const client of old.clients){
   const updated=nextClients.get(client.id);
   if(!updated||BigInt(updated.statusRevision)<BigInt(client.statusRevision)||(updated.statusRevision===client.statusRevision&&updated.active!==client.active))throw Error('Statut client périmé ou incohérent.');
  }
  const nextSales=new Map(next.saleStates.map(s=>[s.saleId,s]));
  for(const sale of old.saleStates) {
   const updated=nextSales.get(sale.saleId);
   if(!updated||updated.clientId!==sale.clientId||updated.version<sale.version||(updated.version===sale.version&&canonicalJson(updated)!==canonicalJson(sale))|| (sale.creditNote&&(!updated.creditNote||canonicalJson(updated.creditNote)!==canonicalJson(sale.creditNote))))throw Error('Référence de vente périmée ou incohérente.');
  }
  // Une preuve de source active ne peut changer sans nouvelle version ;
  // lors d'un avoir, la preuve de la facture d'origine doit être identique.
  const activeProofs=new Map(next.eligibleSaleProofs.map(p=>[p.saleId,p]));
  const cancelledProofs=new Map(next.saleProofs.map(p=>[p.saleId,p]));
  for(const p of old.eligibleSaleProofs){
   const state=nextSales.get(p.saleId),updated=state?.creditNote?cancelledProofs.get(p.saleId):activeProofs.get(p.saleId);
   if(updated&&updated.version===p.version&&canonicalJson(updated)!==canonicalJson(p))throw Error('Preuve de source vente incohérente.');
   if(state?.creditNote&&(!updated||updated.version<p.version))throw Error('Preuve de vente annulée incohérente.');
  }
  const nextSaleProofs=new Map(next.saleProofs.map(p=>[p.saleId,p]));
  for(const p of old.saleProofs)if(canonicalJson(nextSaleProofs.get(p.saleId))!==canonicalJson(p))throw Error('Preuve de vente périmée ou incohérente.');
  const nextJournals=new Map(next.journalStates.map(s=>[s.id,s]));
  for(const journal of old.journalStates) {
   const updated=nextJournals.get(journal.id);
   if(!updated||updated.clientId!==journal.clientId||updated.journalDate!==journal.journalDate||updated.total!==journal.total||updated.version<journal.version||updated.version-journal.version!==updated.receipts.length-journal.receipts.length||journal.receipts.some((r,i)=>canonicalJson(r)!==canonicalJson(updated.receipts[i]))|| (journal.creditNote&&(!updated.creditNote||canonicalJson(updated.creditNote)!==canonicalJson(journal.creditNote))))throw Error('Référence du journal périmée ou incohérente.');
  }
  // À version identique, le contenu complet de la préétablie est immuable,
  // y compris lorsque son avoir vient d'être créé (il ne change pas la source).
  // Une version supérieure peut ajouter un reçu et produit une nouvelle preuve.
  const nextJournalProofs=new Map(next.journalProofs.map(p=>[p.id,p]));
  for(const p of old.journalProofs){
   const updated=nextJournalProofs.get(p.id);
   if(!updated||updated.version<p.version||(updated.version===p.version&&canonicalJson(updated)!==canonicalJson(p)))throw Error('Preuve de préétablie périmée ou incohérente.');
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
