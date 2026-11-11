/** Diagnostic v5 d'une vente de ce téléphone. Lecture seulement : aucune
 * donnée ni file locale n'est remplacée par une copie distante. */
import {canonicalJson} from '@sls/domain';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {saveVerifiedCreditReference} from './credit-note-sync-reference';
import {validateRemoteSaleSourcePrototype} from './credit-remote-sale-edit-prototype';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
const obj=(x:unknown):Record<string,any>|null=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,any>:null;
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const keys=(x:Record<string,unknown>,expected:string)=>Object.keys(x).sort().join(',')===expected;
export async function inspectLocalSaleHistoryPrototype(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,localId:number,saleId:string,value:unknown,digest:(text:string)=>Promise<string>){
 const device=await getDeviceIdentity(tx);if(!device||device.commercialId!==identity.commercialId||device.serverOrigin!==identity.serverOrigin||identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Identité ou serveur incohérent.');
 if(!Number.isSafeInteger(localId)||localId<1||!uuid(saleId))throw Error('Vente locale invalide.');
 const row=await tx.getFirstAsync<{clientId:string;payload:string}>('SELECT client_id AS clientId,payload FROM sales WHERE id=?',localId);
 if(!row)throw Error('Vente locale introuvable.');
 let localValue:Record<string,any>;try{localValue=JSON.parse(row.payload);}catch{throw Error('Vente locale illisible.');}
 if(!obj(localValue)||'id' in localValue)throw Error('Vente locale invalide.');
 const local=validateRemoteSaleSourcePrototype(localValue);
 if(local.syncSaleId!==saleId||local.clientId!==row.clientId||!Number.isSafeInteger(local.syncVersion)||local.syncVersion!<1)throw Error('Vente locale incohérente.');
 const response=obj(value);
 if(!response||!keys(response,'clientId,events,ownerId,reference,saleId')||response.ownerId!==identity.commercialId||response.saleId!==saleId||response.clientId!==row.clientId||!Array.isArray(response.events)||response.events.length<1||response.events.length>200)throw Error('Historique serveur invalide.');
 const events:{commercialId:string;event:{operationId:string;saleId:string;version:number;recordedAt:string;sale:typeof local;refund:number}}[]=[],seen=new Set<string>();
 for(const [index,item] of response.events.entries()){
  const pair=obj(item),e=obj(pair?.event),sale=obj(e?.sale);
  if(!pair||!keys(pair,'commercialId,event')||!uuid(pair.commercialId)||!e||!keys(e,'operationId,recordedAt,refund,sale,saleId,version')||!uuid(e.operationId)||seen.has(e.operationId)||e.saleId!==saleId||e.version!==index+1||!sale||typeof e.recordedAt!=='string'||!Number.isFinite(Date.parse(e.recordedAt))||!Number.isSafeInteger(e.refund)||e.refund<0)throw Error('Événement de vente invalide.');
  const parsed=validateRemoteSaleSourcePrototype(sale);if(parsed.clientId!==row.clientId||parsed.syncSaleId!==saleId||parsed.syncVersion!==e.version||parsed.createdAt!==local.createdAt)throw Error('Historique de vente incohérent.');
  const prior=events[index-1];
  if(!prior){if(pair.commercialId!==identity.commercialId||e.refund!==0||parsed.paid>parsed.total||Date.parse(e.recordedAt)!==Date.parse(parsed.createdAt))throw Error('Première version incohérente.');}
  else if(Date.parse(e.recordedAt)<Date.parse(prior.event.recordedAt)||parsed.paid!==prior.event.sale.paid-e.refund||e.refund>Math.max(0,prior.event.sale.paid-parsed.total))throw Error('Historique de paiement incohérent.');
  seen.add(e.operationId);events.push({commercialId:pair.commercialId,event:{operationId:e.operationId,saleId,version:e.version,recordedAt:e.recordedAt,sale:parsed,refund:e.refund}});
 }
 await tx.runAsync('SAVEPOINT local_sale_history');
 try{
  const ref=await saveVerifiedCreditReference(tx,identity,verified,response.reference,digest),state=ref.saleStates.find(s=>s.saleId===saleId),last=events[events.length-1].event;
  const proof=state?.creditNote?ref.saleProofs.find(p=>p.saleId===saleId):ref.eligibleSaleProofs.find(p=>p.saleId===saleId);
  const {id:_id,...lastSource}=last.sale;
  if(!state||state.clientId!==row.clientId||!proof||proof.version!==last.version||(state.creditNote?state.creditNote.command.expectedVersion!==last.version:state.version!==last.version)||await digest(canonicalJson(lastSource))!==proof.hash)throw Error('Preuve serveur incohérente.');
  const pending=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM sales_outbox WHERE sale_id=?) OR EXISTS(SELECT 1 FROM offline_credit_prototype WHERE kind='sale' AND invoice_id=?) OR EXISTS(SELECT 1 FROM credit_remote_sale_confirm_prototype WHERE invoice_id=? AND acknowledged<2) AS n`,saleId,saleId,saleId);
  if(!pending)throw Error('État des opérations indisponible.');
  const known=events.find(e=>e.event.version===local.syncVersion),{id:_localId,...localSource}=local,{id:_knownId,...knownSource}=known?.event.sale??({id:0} as typeof local);
  const same=!!known&&canonicalJson(localSource)===canonicalJson(knownSource);
  const status=pending.n?'pending' as const:!same?'diverged' as const:state.creditNote?'cancelled' as const:last.version>local.syncVersion!?'updated' as const:'same' as const;
  const fingerprint=await digest(canonicalJson({ownerId:response.ownerId,localId,saleId,clientId:row.clientId,local:localSource,pending:!!pending.n,events:response.events,state,proof}));
  if(!/^[0-9a-f]{64}$/.test(fingerprint))throw Error('Empreinte de comparaison invalide.');
  return {saleId,clientId:row.clientId,status,local,events,cancelled:!!state.creditNote,serverVersion:state.version,fingerprint};
 }finally{await tx.runAsync('ROLLBACK TO local_sale_history');await tx.runAsync('RELEASE local_sale_history');}
}
