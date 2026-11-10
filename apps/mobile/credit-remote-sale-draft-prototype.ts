/** Brouillons isolés de révision distante. Pas une vente, pas une file de
 * synchronisation, pas un solde : ne jamais annoncer une facture modifiée.
 * L'appelant doit garder une transaction SQLite exclusive jusqu'au commit. */
import {canonicalJson} from '@sls/domain';
import type {CreditWriteContext} from './credit-note-write-guard-prototype';
import type {EditLine} from './credit-sale-edit-prototype';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {previewRemoteSaleEditPrototype,type RemoteSaleKey} from './credit-remote-sale-edit-prototype';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
type Preview=Awaited<ReturnType<typeof previewRemoteSaleEditPrototype>>;
export type RemoteEditDraftRequest={operationId:string;context:CreditWriteContext;key:RemoteSaleKey;recordedAt:string;lines:EditLine[];choice?:'refund'|'credit';preview:Preview};
export const remoteSaleDraftPrototypeSchema=`CREATE TABLE IF NOT EXISTS credit_remote_sale_draft_prototype (
 operation_id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL UNIQUE, commercial_id TEXT NOT NULL,
 server_origin TEXT NOT NULL, request TEXT NOT NULL, preview TEXT NOT NULL
);`;
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const rawRequest=(request:RemoteEditDraftRequest)=>({operationId:request.operationId,context:request.context,key:request.key,recordedAt:request.recordedAt,lines:request.lines,choice:request.choice??null,preview:request.preview});
async function assertIdentity(tx:Tx,identity:DeviceIdentity){const actual=await getDeviceIdentity(tx);if(!actual||actual.commercialId!==identity.commercialId||actual.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur incohérent.');}
/** Enregistre seulement un brouillon immuable après un second aperçu dans la
 * même transaction. Une reprise identique retourne le brouillon d'origine ;
 * un autre contenu avec le même UUID ou une autre demande sur la facture est
 * refusé. Ne pas utiliser comme mécanisme d'envoi ou de calcul de solde. */
export async function stageRemoteSaleEditDraftPrototype(tx:Tx,request:RemoteEditDraftRequest,digest:(text:string)=>Promise<string>){
 if(!request||!uuid(request.operationId)||!request.context?.identity||!request.key||!request.preview||!Array.isArray(request.lines))throw Error('Demande de brouillon invalide.');
 await assertIdentity(tx,request.context.identity);
 const serialized=canonicalJson(rawRequest(request));
 const existing=await tx.getFirstAsync<{invoiceId:string;commercialId:string;serverOrigin:string;request:string;preview:string}>('SELECT invoice_id AS invoiceId,commercial_id AS commercialId,server_origin AS serverOrigin,request,preview FROM credit_remote_sale_draft_prototype WHERE operation_id=?',request.operationId);
 if(existing){
  if(existing.invoiceId!==request.key.invoiceId||existing.commercialId!==request.context.identity.commercialId||existing.serverOrigin!==request.context.identity.serverOrigin||existing.request!==serialized||existing.preview!==canonicalJson(request.preview))throw Error('Identifiant de brouillon déjà utilisé avec un autre contenu.');
  return {status:'draft-only' as const,operationId:request.operationId,preview:request.preview,replayed:true};
 }
 const invoice=await tx.getFirstAsync<{operationId:string}>('SELECT operation_id AS operationId FROM credit_remote_sale_draft_prototype WHERE invoice_id=?',request.key.invoiceId);
 if(invoice)throw Error('Un brouillon existe déjà pour cette facture.');
 const preview=await previewRemoteSaleEditPrototype(tx,request.context,request.key,request.recordedAt,request.lines,request.choice,digest);
 if(canonicalJson(preview)!==canonicalJson(request.preview))throw Error('Aperçu modifié : vérifiez à nouveau.');
 await tx.runAsync('INSERT INTO credit_remote_sale_draft_prototype(operation_id,invoice_id,commercial_id,server_origin,request,preview) VALUES(?,?,?,?,?,?)',request.operationId,request.key.invoiceId,request.context.identity.commercialId,request.context.identity.serverOrigin,serialized,canonicalJson(preview));
 return {status:'draft-only' as const,operationId:request.operationId,preview,replayed:false};
}
