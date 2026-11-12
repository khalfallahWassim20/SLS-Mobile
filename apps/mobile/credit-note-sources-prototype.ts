/** Copies reçues d'autres appareils : cache isolé, jamais ajouté aux ventes ou
 * au journal actifs. L'appelant doit utiliser une transaction SQLite exclusive. */
import {canonicalJson} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import {readPrototypeCreditReferenceCache} from './credit-note-reference-cache-prototype';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type Reference=NonNullable<Awaited<ReturnType<typeof readPrototypeCreditReferenceCache>>>;
const obj=(x:unknown):Record<string,any>|null=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,any>:null;
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
export const creditSourcesPrototypeSchema=`CREATE TABLE IF NOT EXISTS credit_sources_prototype_cache (
 client_id TEXT PRIMARY KEY,commercial_id TEXT NOT NULL,server_origin TEXT NOT NULL,payload TEXT NOT NULL
);`;
/** Vérifie l'intégralité par rapport à la référence v5 en cache, y compris le
 * contenu complet et le statut du client. Une liste tronquée est refusée. */
export async function validateCreditSources(value:unknown,reference:Reference,clientId:string,digest:(text:string)=>Promise<string>){
 const raw=obj(value),client=reference.clients.find(c=>c.id===clientId);
 if(!client||!raw||raw.version!==5||raw.clientId!==clientId||raw.active!==client.active||typeof raw.truncated!=='boolean'||!Array.isArray(raw.items))throw Error('Sources de factures invalides.');
 if(raw.truncated||raw.items.length>200)throw Error('Trop de factures : sélection plus précise nécessaire.');
 const sales=new Map(reference.saleStates.filter(s=>s.clientId===clientId&&!s.creditNote).map(s=>[s.saleId,s]));
 const saleProofs=new Map(reference.eligibleSaleProofs.filter(p=>sales.has(p.saleId)).map(p=>[p.saleId,p]));
 const journals=new Map(reference.journalStates.filter(j=>j.clientId===clientId&&!j.creditNote&&reference.eligibleJournalIds.includes(j.id)).map(j=>[j.id,j]));
 const journalProofs=new Map(reference.journalProofs.filter(p=>journals.has(p.id)).map(p=>[p.id,p]));
 const seen=new Set<string>(),items=[];
 for(const value of raw.items){
  const item=obj(value),source=obj(item?.source);
  if(!item||!source||!uuid(item.invoiceId)||!['sale','preinvoice'].includes(item.kind)||!Number.isSafeInteger(item.version)||item.version<1||typeof item.hash!=='string'||!/^[0-9a-f]{64}$/.test(item.hash)||seen.has(`${item.kind}:${item.invoiceId}`))throw Error('Source de facture invalide.');
  seen.add(`${item.kind}:${item.invoiceId}`);
  if(item.kind==='sale'){
   const state=sales.get(item.invoiceId),proof=saleProofs.get(item.invoiceId);
   if(!state||!proof||proof.version!==item.version||proof.hash!==item.hash||source.syncSaleId!==item.invoiceId||source.syncVersion!==item.version||source.clientId!==clientId||String(source.total)!==state.total||String(source.paid)!==state.paid)throw Error('Source de vente non confirmée.');
   saleProofs.delete(item.invoiceId);
  }else{
   const state=journals.get(item.invoiceId),proof=journalProofs.get(item.invoiceId),invoice=obj(source.invoice);
   if(!state||!proof||proof.version!==item.version||proof.hash!==item.hash||source.version!==item.version||invoice?.id!==item.invoiceId||invoice.clientId!==clientId||invoice.journalDate!==state.journalDate||invoice.amount!==state.total||!Array.isArray(source.receipts))throw Error('Source préétablie non confirmée.');
   journalProofs.delete(item.invoiceId);
  }
  if(await digest(canonicalJson(source))!==item.hash)throw Error('Empreinte de facture incohérente.');
  items.push({kind:item.kind as 'sale'|'preinvoice',invoiceId:item.invoiceId as string,version:item.version as number,hash:item.hash as string,source});
 }
 if(saleProofs.size||journalProofs.size)throw Error('Sources de factures incomplètes.');
 return {version:5 as const,clientId,active:client.active,truncated:false as const,items};
}
/** La session vérifiée et le téléphone lié doivent correspondre ; l'ancien
 * cache reste intact en cas d'échec. */
export async function saveCreditSourcesPrototype(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,clientId:string,value:unknown,digest:(text:string)=>Promise<string>){
 if(identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur incohérent.');
 const reference=await readPrototypeCreditReferenceCache(tx,identity);if(!reference)throw Error('Référence d’avoirs indisponible.');
 const result=await validateCreditSources(value,reference,clientId,digest);
 await tx.runAsync('INSERT INTO credit_sources_prototype_cache(client_id,commercial_id,server_origin,payload) VALUES(?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET commercial_id=excluded.commercial_id,server_origin=excluded.server_origin,payload=excluded.payload',clientId,identity.commercialId,identity.serverOrigin,JSON.stringify(result));
 return result;
}
/** Un cache devenu périmé depuis l'actualisation de la référence est refusé. */
export async function readCreditSourcesPrototype(tx:Tx,identity:DeviceIdentity,clientId:string,digest:(text:string)=>Promise<string>){
 const reference=await readPrototypeCreditReferenceCache(tx,identity);if(!reference)throw Error('Référence d’avoirs indisponible.');
 const row=await tx.getFirstAsync<{commercialId:string;serverOrigin:string;payload:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM credit_sources_prototype_cache WHERE client_id=?',clientId);
 if(!row)return null;
 if(row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin)throw Error('Cache de factures lié à une autre identité.');
 return validateCreditSources(JSON.parse(row.payload),reference,clientId,digest);
}
