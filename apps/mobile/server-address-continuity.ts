/** Comparaison de sécurité préparatoire, non preuve d'identité : une copie de
 * la base ou une restauration récente peut présenter les mêmes opérations.
 * À effectuer sous transaction exclusive avec une réponse authentifiée HTTPS. */
import {canonicalJson} from '@sls/domain';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {validateIdentifiedReference} from './identified-reference';
import {validatePrototypeCreditReference} from './credit-note-reference-prototype';
import {saveVerifiedCreditReference} from './credit-note-sync-reference';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type Cache={commercialId:string;serverOrigin:string;payload:string};
/** Tous les marqueurs déjà confirmés doivent toujours exister avec le même
 * contenu et la même version. Même une progression légitime est refusée si
 * elle ne peut être prouvée ici. Aucun cache n'est enregistré ou supprimé. */
export async function inspectAddressContinuity(tx:Tx,identity:DeviceIdentity,version:4|5,value:unknown,digest:(s:string)=>Promise<string>):Promise<{anchors:number;version:4|5}>{
 const bound=await getDeviceIdentity(tx);
 if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin)throw Error('Liaison modifiée : rapprochement nécessaire.');
 const cacheTable=version===5?'credit_reference_prototype_cache':'identified_reference_cache';
 const cache=await tx.getFirstAsync<Cache>(`SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM ${cacheTable} WHERE id=1`);
 if(!cache||cache.commercialId!==identity.commercialId||cache.serverOrigin!==identity.serverOrigin)throw Error('Ancienne référence indisponible : rapprochement nécessaire.');
 let raw:unknown;try{raw=JSON.parse(cache.payload);}catch{throw Error('Ancienne référence illisible.');}
 const old=version===5?validatePrototypeCreditReference(raw):validateIdentifiedReference(raw);
 const next=version===5?validatePrototypeCreditReference(value):validateIdentifiedReference(value);
 const nextSales=new Map(next.saleStates?.map(s=>[s.saleId,s])??[]),nextSettlements=new Map(next.settlementStates?.map(s=>[s.operationId,s])??[]);
 const nextJournal=new Map(next.journalStates?.map(j=>[j.id,j])??[]),nextProofs=new Map(next.journalProofs.map(p=>[p.id,p]));
 for(const sale of old.saleStates??[]){const candidate=nextSales.get(sale.saleId);if(!candidate||canonicalJson(candidate)!==canonicalJson(sale))throw Error('Historique de vente différent ou avancé : rapprochement nécessaire.');}
 for(const item of old.settlementStates??[]){const candidate=nextSettlements.get(item.operationId);if(!candidate||canonicalJson(candidate)!==canonicalJson(item))throw Error('Historique de règlement différent : rapprochement nécessaire.');}
 for(const item of old.journalStates??[]){const candidate=nextJournal.get(item.id);if(!candidate||canonicalJson(candidate)!==canonicalJson(item))throw Error('Historique de journal différent ou avancé : rapprochement nécessaire.');}
 for(const proof of old.journalProofs){const candidate=nextProofs.get(proof.id);if(!candidate||canonicalJson(candidate)!==canonicalJson(proof))throw Error('Preuve de journal différente : rapprochement nécessaire.');}
 const anchors=(old.saleStates?.length??0)+(old.settlementStates?.length??0)+old.journalProofs.length;
 if(!anchors)throw Error('Aucune opération confirmée dans l’ancienne référence : rapprochement manuel nécessaire.');
 if(version===5){
  // Réutilise les vérifications exhaustives des avoirs confirmés et des
  // versions v5, sans conserver l'écriture temporaire même en cas d'erreur.
  await tx.runAsync('SAVEPOINT continuity_v5_check');
  try{await saveVerifiedCreditReference(tx,identity,identity,value,digest);}
  finally{await tx.runAsync('ROLLBACK TO SAVEPOINT continuity_v5_check');await tx.runAsync('RELEASE SAVEPOINT continuity_v5_check');}
 }
 return {anchors,version};
}
