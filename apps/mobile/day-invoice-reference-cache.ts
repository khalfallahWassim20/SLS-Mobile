/** Cache v6 préparatoire, distinct des caches v4/v5. Toute écriture doit être
 * faite dans une transaction exclusive après authentification du serveur.
 * Les références v5 ne sont pas compatibles : on ne les efface jamais. */
import {canonicalJson} from '@sls/domain';
import {assertNoLocalDayCompensation} from './day-invoice-compensation-guard';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {validateDayInvoiceReference} from './day-invoice-reference';
import {validateIdentifiedReference} from './identified-reference';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export const dayInvoiceReferenceCacheSchema=`CREATE TABLE IF NOT EXISTS day_invoice_reference_cache (
 id INTEGER PRIMARY KEY CHECK(id=1),commercial_id TEXT NOT NULL,server_origin TEXT NOT NULL,payload TEXT NOT NULL
);`;
type V6=ReturnType<typeof validateDayInvoiceReference>;
type V4=ReturnType<typeof validateIdentifiedReference>;
type CacheRow={commercialId:string;serverOrigin:string;payload:string};
async function identityIsBound(tx:Tx,id:DeviceIdentity) {
 const actual=await getDeviceIdentity(tx);
 if(!actual||actual.commercialId!==id.commercialId||actual.serverOrigin!==id.serverOrigin)throw Error('Identité ou serveur du téléphone incohérent.');
}
/** Les traces de la précédente capture ne doivent pas disparaître ou régresser.
 * Une facture plus récente peut ajouter des reçus, jamais modifier son passé. */
function assertBaseProgress(old:V4|V6,next:V6) {
 if(!old.saleStates||!next.saleStates||!old.settlementStates||!next.settlementStates||!old.journalStates||!next.journalStates)throw Error('Référence précédente incomplète.');
 const sales=new Map(next.saleStates.map(s=>[s.saleId,s]));
 for(const s of old.saleStates){const n=sales.get(s.saleId);if(!n||n.clientId!==s.clientId||n.version<s.version||(n.version===s.version&&canonicalJson(n)!==canonicalJson(s)))throw Error('Vente serveur périmée ou incohérente.');}
 const settlements=new Map(next.settlementStates.map(s=>[s.operationId,s.clientId]));
 for(const s of old.settlementStates)if(settlements.get(s.operationId)!==s.clientId)throw Error('Règlement serveur périmé ou incohérent.');
 const journals=new Map(next.journalStates.map(j=>[j.id,j]));
 const oldProof=new Map(old.journalProofs.map(p=>[p.id,p]));
 const newProof=new Map(next.journalProofs.map(p=>[p.id,p]));
 for(const j of old.journalStates){
  const n=journals.get(j.id),a=oldProof.get(j.id),b=newProof.get(j.id);
  if(!n||!a||!b||n.clientId!==j.clientId||n.journalDate!==j.journalDate||n.total!==j.total||b.version<a.version||b.version-a.version!==n.receipts.length-j.receipts.length||j.receipts.some((r,i)=>canonicalJson(r)!==canonicalJson(n.receipts[i]))||(a.version===b.version&&a.hash!==b.hash))throw Error('Facture serveur périmée ou incohérente.');
 }
 const clients=new Set(next.clients.map(c=>c.id));
 for(const client of old.clients)if(!clients.has(client.id))throw Error('Client serveur absent : rapprochement nécessaire.');
}
function assertPaymentProgress(old:V6,next:V6) {
 if(old.hasSaleProofs&&!next.hasSaleProofs)throw Error('Preuves de vente absentes : régression refusée.');
 if(old.hasSaleProofs){const proofs=new Map(next.saleProofs.map(p=>[p.saleId,p]));for(const prior of old.saleProofs){const current=proofs.get(prior.saleId);if(!current||current.version<prior.version||(current.version===prior.version&&current.hash!==prior.hash))throw Error('Preuve de vente périmée ou incohérente.');}}
 const dates=new Map(next.saleDays.map(s=>[s.saleId,s]));
 for(const sale of old.saleDays)if(canonicalJson(dates.get(sale.saleId)??null)!==canonicalJson(sale))throw Error('Journée de vente périmée ou incohérente.');
 const settlements=new Map(next.settlementDays.map(s=>[s.operationId,s]));
 for(const item of old.settlementDays)if(canonicalJson(settlements.get(item.operationId)??null)!==canonicalJson(item))throw Error('Journée de règlement périmée ou incohérente.');
 const proofs=new Map(next.settlementProofs.map(p=>[p.operationId,p]));
 for(const proof of old.settlementProofs)if(canonicalJson(proofs.get(proof.operationId)??null)!==canonicalJson(proof))throw Error('Preuve de règlement périmée ou incohérente.');
 const markers=new Map(next.oldDebtMarkers.map(m=>[m.operationId,m]));
 for(const marker of old.oldDebtMarkers)if(canonicalJson(markers.get(marker.operationId)??null)!==canonicalJson(marker))throw Error('Marqueur de dette périmé ou incohérent.');
 const previousMarkers=new Set(old.oldDebtMarkers.map(m=>m.operationId));
 const previousSettlements=new Set(old.settlementDays.map(s=>s.operationId));
 for(const marker of next.oldDebtMarkers)if(previousSettlements.has(marker.operationId)&&!previousMarkers.has(marker.operationId))throw Error('Classification rétroactive d’un règlement refusée.');
 const payments=new Map(next.dayPayments.map(p=>[p.operationId,p]));
 for(const p of old.dayPayments){const found=payments.get(p.operationId);if(!found||canonicalJson(found)!==canonicalJson(p))throw Error('Paiement serveur périmé ou incohérent.');}
}
/** Compare aussi le cache v4, sans le remplacer. Si v5 existe, l'intégration
 * doit d'abord fournir un protocole combiné ; aucune régression silencieuse. */
export async function saveDayInvoiceReference(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,input:unknown):Promise<void> {
 // La reprise de compensation utilise cette référence comme photographie
 // antérieure. Ne pas la remplacer, même après réception du serveur : aucun
 // mécanisme de réconciliation historique n'est encore disponible.
 await assertNoLocalDayCompensation(tx);
 await identityIsBound(tx,identity);
 if(verified.commercialId!==identity.commercialId||verified.serverOrigin!==identity.serverOrigin)throw Error('Session ou serveur incohérent.');
 const next=validateDayInvoiceReference(input);
 const v5=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM credit_reference_prototype_cache) AS n');
 if(!v5||v5.n)throw Error('Cache v5 présent ou indisponible : protocole combiné requis.');
 const oldV4=await tx.getFirstAsync<CacheRow>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM identified_reference_cache WHERE id=1');
 if(oldV4){if(oldV4.commercialId!==identity.commercialId||oldV4.serverOrigin!==identity.serverOrigin)throw Error('Cache v4 lié à une autre identité.');assertBaseProgress(validateIdentifiedReference(JSON.parse(oldV4.payload)),next);}
 const previous=await tx.getFirstAsync<CacheRow>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM day_invoice_reference_cache WHERE id=1');
 if(previous){if(previous.commercialId!==identity.commercialId||previous.serverOrigin!==identity.serverOrigin)throw Error('Cache v6 lié à une autre identité.');const old=validateDayInvoiceReference(JSON.parse(previous.payload));assertBaseProgress(old,next);assertPaymentProgress(old,next);}
 // Conserver la forme reçue : le validateur transforme les indicateurs de
 // déclaration en tableau, il ne faut donc pas sérialiser son résultat.
 await tx.runAsync(`INSERT INTO day_invoice_reference_cache(id,commercial_id,server_origin,payload) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET commercial_id=excluded.commercial_id,server_origin=excluded.server_origin,payload=excluded.payload`,identity.commercialId,identity.serverOrigin,JSON.stringify(input));
}
export async function readDayInvoiceReferenceCache(tx:Tx,identity:DeviceIdentity):Promise<V6|null> {
 await identityIsBound(tx,identity);
 const v5=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM credit_reference_prototype_cache) AS n');
 if(!v5||v5.n)throw Error('Cache v5 présent ou indisponible : protocole combiné requis.');
 const row=await tx.getFirstAsync<CacheRow>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM day_invoice_reference_cache WHERE id=1');
 if(!row)return null;
 if(row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin)throw Error('Cache v6 lié à une autre identité.');
 return validateDayInvoiceReference(JSON.parse(row.payload));
}
