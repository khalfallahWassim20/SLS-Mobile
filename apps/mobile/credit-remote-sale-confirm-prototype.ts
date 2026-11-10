/** Circuit isolé de confirmation des révisions distantes. Non raccordé à
 * l'application ou à sa synchronisation : les écritures, soldes et files sont
 * séparés. Chaque fonction SQLite exige une transaction exclusive. */
import {canonicalJson,calculateInvoice,revisePayment} from '@sls/domain';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {readPrototypeCreditReferenceCache} from './credit-note-reference-cache-prototype';
import {saveVerifiedCreditReference} from './credit-note-sync-reference';
import {readPrototypeCreditBalance} from './credit-note-balance-storage-prototype';
import {previewRemoteSaleEditPrototype} from './credit-remote-sale-edit-prototype';
import type {RemoteEditDraftRequest} from './credit-remote-sale-draft-prototype';
import type {IdentifiedEntry} from './identified-upload';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
export const remoteSaleConfirmPrototypeSchema=`CREATE TABLE IF NOT EXISTS credit_remote_sale_confirm_prototype (
 operation_id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL,
 commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL, recorded_at TEXT NOT NULL,
 request TEXT NOT NULL, original TEXT NOT NULL, revised TEXT NOT NULL, payload TEXT NOT NULL,
 acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1))
);`;
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const serialize=(r:RemoteEditDraftRequest)=>canonicalJson({operationId:r.operationId,context:r.context,key:r.key,recordedAt:r.recordedAt,lines:r.lines,choice:r.choice??null,preview:r.preview});
async function bound(tx:Tx,id:DeviceIdentity){const actual=await getDeviceIdentity(tx);if(!actual||actual.commercialId!==id.commercialId||actual.serverOrigin!==id.serverOrigin)throw Error('Identité ou serveur incohérent.');}
type Row={operationId:string;invoiceId:string;clientId:string;commercialId:string;serverOrigin:string;recordedAt:string;request:string;original:string;revised:string;payload:string;acknowledged:number};
const columns=`operation_id AS operationId,invoice_id AS invoiceId,client_id AS clientId,commercial_id AS commercialId,server_origin AS serverOrigin,recorded_at AS recordedAt,request,original,revised,payload,acknowledged`;
function parse(row:Row,identity:DeviceIdentity){
 if(!uuid(row.operationId)||!uuid(row.invoiceId)||row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin||![0,1].includes(row.acknowledged))throw Error('Révision distante liée à une autre identité ou invalide.');
 try{
  const request=JSON.parse(row.request),original=JSON.parse(row.original),revised=JSON.parse(row.revised),event=JSON.parse(row.payload);
  if(request.operationId!==row.operationId||request.key.invoiceId!==row.invoiceId||request.key.clientId!==row.clientId||request.context.identity.commercialId!==row.commercialId||request.context.identity.serverOrigin!==row.serverOrigin||request.recordedAt!==row.recordedAt||original.syncSaleId!==row.invoiceId||original.clientId!==row.clientId||revised.syncSaleId!==row.invoiceId||revised.clientId!==row.clientId||revised.syncVersion!==original.syncVersion+1||event.operationId!==row.operationId||event.saleId!==row.invoiceId||event.version!==revised.syncVersion||canonicalJson(event.sale)!==canonicalJson(revised)||canonicalJson(request.preview.previous)!==canonicalJson({...original,id:1})||canonicalJson(request.preview.updated)!==canonicalJson({...revised,id:1,syncVersion:original.syncVersion})||event.refund!==request.preview.refund)throw Error();
  const total=calculateInvoice(revised.lines.map((l:{quantity:number;unitPrice:number;discount:number;vat:number})=>({quantity:l.quantity,unitPrice:l.unitPrice,discountRate:l.discount,vatRate:l.vat}))).total;
  const payment=revisePayment(total,original.paid,request.choice??undefined),balance=BigInt(request.context.expectedBalance)+BigInt(total)-BigInt(payment.paid)-BigInt(original.total)+BigInt(original.paid);
  if(!Number.isSafeInteger(request.context.expectedBalance)||!Number.isSafeInteger(original.total)||!Number.isSafeInteger(revised.total)||canonicalJson(request.preview.key)!==canonicalJson(request.key)||canonicalJson(request.lines)!==canonicalJson(revised.lines)||total!==revised.total||payment.paid!==revised.paid||payment.remaining!==revised.remaining||payment.refund!==event.refund||payment.credit!==request.preview.credit||request.preview.balanceBefore!==request.context.expectedBalance||balance!==BigInt(request.preview.balanceAfter))throw Error();
  return {request,original,revised,event};
 }catch{throw Error('Révision distante illisible ou incohérente.');}
}
/** Confirme seulement dans le registre expérimental ; ne touche pas aux
 * ventes et files actives. Reprise avec UUID et contenu identiques possible. */
export async function confirmRemoteSaleEditPrototype(tx:Tx,request:RemoteEditDraftRequest,digest:(text:string)=>Promise<string>){
 if(!request||!uuid(request.operationId)||!request.context?.identity||!request.key||!request.preview||!Array.isArray(request.lines))throw Error('Demande de révision invalide.');
 await bound(tx,request.context.identity);const content=serialize(request);
 const existing=await tx.getFirstAsync<Row>(`SELECT ${columns} FROM credit_remote_sale_confirm_prototype WHERE operation_id=?`,request.operationId);
 if(existing){parse(existing,request.context.identity);if(existing.request!==content)throw Error('Identifiant déjà utilisé avec un autre contenu.');return {operationId:request.operationId,replayed:true};}
 if(await tx.getFirstAsync<{operationId:string}>('SELECT operation_id AS operationId FROM credit_remote_sale_confirm_prototype WHERE invoice_id=?',request.key.invoiceId))throw Error('Une révision distante existe déjà pour cette facture.');
 const draft=await tx.getFirstAsync<{request:string;preview:string}>('SELECT request,preview FROM credit_remote_sale_draft_prototype WHERE operation_id=?',request.operationId);
 if(!draft||draft.request!==content||draft.preview!==canonicalJson(request.preview))throw Error('Brouillon introuvable ou modifié.');
 const fresh=await previewRemoteSaleEditPrototype(tx,request.context,request.key,request.recordedAt,request.lines,request.choice,digest);
 if(canonicalJson(fresh)!==canonicalJson(request.preview))throw Error('Aperçu modifié : vérifiez à nouveau.');
 const {id:_previousId,...original}=fresh.previous,{id:_updatedId,...next}=fresh.updated,revised={...next,syncVersion:original.syncVersion!+1};
 const payload={operationId:request.operationId,saleId:request.key.invoiceId,version:revised.syncVersion,sale:revised,refund:fresh.refund};
 await tx.runAsync('INSERT INTO credit_remote_sale_confirm_prototype(operation_id,invoice_id,client_id,commercial_id,server_origin,recorded_at,request,original,revised,payload,acknowledged) VALUES(?,?,?,?,?,?,?,?,?,?,0)',request.operationId,request.key.invoiceId,request.key.clientId,request.context.identity.commercialId,request.context.identity.serverOrigin,request.recordedAt,content,canonicalJson(original),canonicalJson(revised),canonicalJson(payload));
 return {operationId:request.operationId,replayed:false};
}
/** Solde distinct pour essais : chaque source est prouvée contre la référence
 * courante ; une autre version ou un avoir provoque un conflit, pas un solde. */
export async function readRemoteEditBalancePrototype(tx:Tx,identity:DeviceIdentity,clientId:string,digest:(text:string)=>Promise<string>){
 await bound(tx,identity);const reference=await readPrototypeCreditReferenceCache(tx,identity);if(!reference)throw Error('Référence v5 indisponible.');
 const base=await readPrototypeCreditBalance(tx,identity,clientId,digest),rows=await tx.getAllAsync<Row>(`SELECT ${columns} FROM credit_remote_sale_confirm_prototype WHERE client_id=? ORDER BY rowid`,clientId);
 let balance=BigInt(base.balance),conflict=base.conflict;
 for(const row of rows){
  const {original,revised}=parse(row,identity),state=reference.saleStates.find(s=>s.saleId===row.invoiceId),proof=reference.eligibleSaleProofs.find(p=>p.saleId===row.invoiceId);
  const overlap=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM sales WHERE json_valid(payload) AND json_extract(payload,'$.syncSaleId')=?) OR EXISTS(SELECT 1 FROM sales_outbox WHERE sale_id=?) AS n`,row.invoiceId,row.invoiceId);
  if(!overlap||overlap.n){conflict=true;continue;}
  if(!state||state.creditNote||state.clientId!==clientId||!proof){conflict=true;continue;}
  if(state.version===original.syncVersion&&proof.version===state.version&&state.total===String(original.total)&&state.paid===String(original.paid)&&await digest(canonicalJson(original))===proof.hash){balance+=BigInt(revised.total)-BigInt(revised.paid)-BigInt(original.total)+BigInt(original.paid);continue;}
  if(state.version===revised.syncVersion&&proof.version===state.version&&state.total===String(revised.total)&&state.paid===String(revised.paid)&&await digest(canonicalJson(revised))===proof.hash)continue;
  conflict=true;
 }
 if(balance<BigInt(Number.MIN_SAFE_INTEGER)||balance>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Solde trop élevé.');
 return {balance:Number(balance),conflict};
}
export async function readRemoteEditQueuePrototype(tx:Tx,identity:DeviceIdentity):Promise<IdentifiedEntry[]>{
 await bound(tx,identity);const rows=await tx.getAllAsync<Row>(`SELECT ${columns} FROM credit_remote_sale_confirm_prototype WHERE acknowledged=0 ORDER BY rowid`);
 return rows.map(row=>{parse(row,identity);return {operationId:row.operationId,entityId:row.invoiceId,commercialId:row.commercialId,recordedAt:row.recordedAt,kind:'sale' as const,payload:row.payload};});
}
/** Ne pas effacer le registre après accusé ; la référence doit encore être
 * récupérée et vérifiée avant d'affirmer que la synchronisation est complète. */
export async function acknowledgeRemoteEditPrototype(tx:Tx,identity:DeviceIdentity,entry:IdentifiedEntry){
 await bound(tx,identity);const row=await tx.getFirstAsync<Row>(`SELECT ${columns} FROM credit_remote_sale_confirm_prototype WHERE operation_id=?`,entry.operationId);
 if(!row||entry.kind!=='sale'||entry.commercialId!==identity.commercialId||entry.entityId!==row.invoiceId||entry.recordedAt!==row.recordedAt||entry.payload!==row.payload||row.acknowledged!==0)throw Error('Accusé de révision incohérent.');
 parse(row,identity);await tx.runAsync('UPDATE credit_remote_sale_confirm_prototype SET acknowledged=1 WHERE operation_id=?',entry.operationId);
}
/** Une opération acquittée n'est considérée synchronisée qu'après récupération
 * de la version exacte et de sa preuve serveur dans la même transaction. */
export async function finalizeRemoteEditReferencePrototype(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,value:unknown,digest:(text:string)=>Promise<string>){
 await bound(tx,identity);await saveVerifiedCreditReference(tx,identity,verified,value,digest);
 const ref=await readPrototypeCreditReferenceCache(tx,identity);if(!ref)throw Error('Référence v5 indisponible.');
 const rows=await tx.getAllAsync<Row>(`SELECT ${columns} FROM credit_remote_sale_confirm_prototype ORDER BY rowid`),clients=new Set<string>();
 for(const row of rows){
  const {revised}=parse(row,identity),state=ref.saleStates.find(s=>s.saleId===row.invoiceId),proof=ref.eligibleSaleProofs.find(p=>p.saleId===row.invoiceId);
  if(!row.acknowledged||!state||state.creditNote||state.clientId!==row.clientId||state.version!==revised.syncVersion||state.total!==String(revised.total)||state.paid!==String(revised.paid)||proof?.version!==state.version||await digest(canonicalJson(revised))!==proof.hash)throw Error('Révision distante non confirmée par la référence : rapprochement nécessaire.');
  clients.add(row.clientId);
 }
 for(const client of clients)if((await readRemoteEditBalancePrototype(tx,identity,client,digest)).conflict)throw Error('Solde distant en conflit.');
}
