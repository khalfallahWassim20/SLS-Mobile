/** Circuit isolé de confirmation des révisions distantes. Non raccordé à
 * l'application ou à sa synchronisation : les écritures, soldes et files sont
 * séparés. Chaque fonction SQLite exige une transaction exclusive. */
import {canonicalJson,calculateInvoice,revisePayment} from '@sls/domain';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {readPrototypeCreditReferenceCache} from './credit-note-reference-cache-prototype';
import {saveVerifiedCreditReference} from './credit-note-sync-reference';
import {readPrototypeCreditBalance} from './credit-note-balance-storage-prototype';
import {previewRemoteSaleEditPrototype,validateRemoteSaleSourcePrototype} from './credit-remote-sale-edit-prototype';
import {validateCreditSources} from './credit-note-sources-prototype';
import type {SavedSale} from './storage';
import type {RemoteEditDraftRequest} from './credit-remote-sale-draft-prototype';
import {ClosedDaySyncError,OperationConflictSyncError,type IdentifiedEntry} from './identified-upload';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
export {remoteSaleConfirmPrototypeSchema} from './credit-remote-sale-schema-prototype';
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const actorUuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const validDay=(x:string)=>{const d=new Date(`${x}T00:00:00.000Z`);return /^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===x;};
const serialize=(r:RemoteEditDraftRequest)=>canonicalJson({operationId:r.operationId,context:r.context,key:r.key,recordedAt:r.recordedAt,lines:r.lines,choice:r.choice??null,preview:r.preview});
async function bound(tx:Tx,id:DeviceIdentity){const actual=await getDeviceIdentity(tx);if(!actual||actual.commercialId!==id.commercialId||actual.serverOrigin!==id.serverOrigin)throw Error('Identité ou serveur incohérent.');}
type Row={operationId:string;invoiceId:string;clientId:string;commercialId:string;serverOrigin:string;recordedAt:string;request:string;original:string;revised:string;payload:string;acknowledged:number};
const columns=`operation_id AS operationId,invoice_id AS invoiceId,client_id AS clientId,commercial_id AS commercialId,server_origin AS serverOrigin,recorded_at AS recordedAt,request,original,revised,payload,acknowledged`;
function parse(row:Row,identity:DeviceIdentity){
 if(!uuid(row.operationId)||!uuid(row.invoiceId)||row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin||![0,1,2].includes(row.acknowledged))throw Error('Révision distante liée à une autre identité ou invalide.');
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
 if(existing){parse(existing,request.context.identity);if(existing.request!==content)throw Error('Identifiant déjà utilisé avec un autre contenu.');if(await tx.getFirstAsync('SELECT operation_id FROM credit_remote_sale_abandoned_prototype WHERE operation_id=?',request.operationId))throw Error('Cette modification a été abandonnée : créez une nouvelle demande.');return {operationId:request.operationId,replayed:true};}
 if(await tx.getFirstAsync<{operationId:string}>('SELECT operation_id AS operationId FROM credit_remote_sale_confirm_prototype WHERE invoice_id=? AND acknowledged<2',request.key.invoiceId))throw Error('Une révision distante existe déjà pour cette facture.');
 const pending=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM sales_outbox) OR EXISTS(SELECT 1 FROM journal_sync_outbox) OR EXISTS(SELECT 1 FROM offline_credit_prototype WHERE pending=1) OR EXISTS(SELECT 1 FROM credit_remote_sale_confirm_prototype WHERE acknowledged<2) AS n`);
 if(!pending||pending.n)throw Error('Synchronisez les opérations en attente avant la révision distante.');
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
 const base=await readPrototypeCreditBalance(tx,identity,clientId,digest,true),rows=await tx.getAllAsync<Row>(`SELECT ${columns} FROM credit_remote_sale_confirm_prototype WHERE client_id=? AND acknowledged<2 ORDER BY rowid`,clientId);
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
 parse(row,identity);await tx.runAsync('UPDATE credit_remote_sale_confirm_prototype SET acknowledged=1 WHERE operation_id=?',entry.operationId);await tx.runAsync('DELETE FROM credit_remote_sale_failure_prototype WHERE operation_id=?',entry.operationId);
}
/** Une opération acquittée n'est considérée synchronisée qu'après récupération
 * de la version exacte et de sa preuve serveur dans la même transaction. */
export async function finalizeRemoteEditReferencePrototype(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,value:unknown,digest:(text:string)=>Promise<string>){
 await bound(tx,identity);await saveVerifiedCreditReference(tx,identity,verified,value,digest);
 const ref=await readPrototypeCreditReferenceCache(tx,identity);if(!ref)throw Error('Référence v5 indisponible.');
 const rows=await tx.getAllAsync<Row>(`SELECT ${columns} FROM credit_remote_sale_confirm_prototype WHERE acknowledged<2 ORDER BY rowid`),clients=new Set<string>();
 for(const row of rows){
  const {revised}=parse(row,identity),state=ref.saleStates.find(s=>s.saleId===row.invoiceId),proof=ref.eligibleSaleProofs.find(p=>p.saleId===row.invoiceId);
  if(row.acknowledged!==1||!state||state.creditNote||state.clientId!==row.clientId||state.version!==revised.syncVersion||state.total!==String(revised.total)||state.paid!==String(revised.paid)||proof?.version!==state.version||await digest(canonicalJson(revised))!==proof.hash)throw Error('Révision distante non confirmée par la référence : rapprochement nécessaire.');
  clients.add(row.clientId);
 }
 for(const client of clients)if((await readRemoteEditBalancePrototype(tx,identity,client,digest)).conflict)throw Error('Solde distant en conflit.');
 for(const row of rows){await tx.runAsync('UPDATE credit_remote_sale_confirm_prototype SET acknowledged=2 WHERE operation_id=?',row.operationId);await tx.runAsync('DELETE FROM credit_remote_sale_draft_prototype WHERE operation_id=?',row.operationId);await tx.runAsync('DELETE FROM credit_sources_prototype_cache WHERE client_id=?',row.clientId);}
}

/** L'indication enregistrée est le dernier refus explicite du serveur, pas
 * une preuve qu'une requête ultérieure ou perdue n'a pas été reçue. */
export async function recordRemoteEditFailurePrototype(tx:Tx,identity:DeviceIdentity,entry:IdentifiedEntry,error:unknown){
 if(!(error instanceof ClosedDaySyncError)&&!(error instanceof OperationConflictSyncError))return;
 await bound(tx,identity);const row=await tx.getFirstAsync<Row>(`SELECT ${columns} FROM credit_remote_sale_confirm_prototype WHERE operation_id=?`,entry.operationId);
 if(!row||row.acknowledged!==0||entry.kind!=='sale'||entry.entityId!==row.invoiceId||entry.payload!==row.payload||entry.recordedAt!==row.recordedAt||entry.commercialId!==identity.commercialId)throw Error('Révision distante incohérente.');
 parse(row,identity);
 const closed=error instanceof ClosedDaySyncError;
 if(closed&&(!actorUuid(error.commercialId)||!validDay(error.day)))throw Error('Refus de clôture invalide.');
 await tx.runAsync(`INSERT INTO credit_remote_sale_failure_prototype(operation_id,reason,day,commercial_id) VALUES(?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET reason=excluded.reason,day=excluded.day,commercial_id=excluded.commercial_id`,entry.operationId,closed?'closed':'conflict',closed?error.day:null,closed?error.commercialId:null);
}
/** Lecture même si les soldes sont bloqués : permet d'expliquer et reprendre
 * une modification sans proposer d'effacer une opération incertaine. */
export async function readPendingRemoteEditPrototype(tx:Tx,identity:DeviceIdentity){
 await bound(tx,identity);const rows=await tx.getAllAsync<Row>(`SELECT ${columns} FROM credit_remote_sale_confirm_prototype WHERE acknowledged<2 ORDER BY rowid`);
 if(rows.length>1)throw Error('Plusieurs révisions distantes nécessitent un rapprochement.');
 if(!rows.length)return null;
 const row=rows[0],{request,original,revised}=parse(row,identity);
 const failure=await tx.getFirstAsync<{reason:string;day:string|null;commercialId:string|null}>('SELECT reason,day,commercial_id AS commercialId FROM credit_remote_sale_failure_prototype WHERE operation_id=?',row.operationId);
 if(failure&&(!['closed','conflict'].includes(failure.reason)||(failure.reason==='closed'&&(!failure.day||!validDay(failure.day)||!actorUuid(failure.commercialId)))||(failure.reason==='conflict'&&(failure.day!==null||failure.commercialId!==null))))throw Error('Détail de refus illisible.');
 return {operationId:row.operationId,invoiceId:row.invoiceId,clientId:row.clientId,clientName:original.clientName,recordedAt:row.recordedAt,originalTotal:original.total,newTotal:revised.total,refund:request.preview.refund,retainedCredit:request.preview.credit,status:row.acknowledged===1?'awaiting-reference' as const:'awaiting-upload' as const,failure:failure?{...failure}:null};
}

/** Capture la requête exacte ; pas de nouvel UUID ni de modification de file. */
export async function readRemoteAbandonCandidatePrototype(tx:Tx,identity:DeviceIdentity){
 const queue=await readRemoteEditQueuePrototype(tx,identity);if(queue.length!==1)throw Error('Aucune révision distante à abandonner, ou état ambigu.');
 const entry=queue[0],event=JSON.parse(entry.payload) as Record<string,unknown>;
 return {entry,event:{...event,recordedAt:entry.recordedAt}};
}
/** Uniquement après accusé serveur explicite et référence authentifiée. Une
 * réponse perdue ne supprime rien ; la reprise réutilise le même UUID. */
export async function resolveRemoteAbandonPrototype(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,entry:IdentifiedEntry,response:unknown,reference:unknown,digest:(text:string)=>Promise<string>){
 await bound(tx,identity);const row=await tx.getFirstAsync<Row>(`SELECT ${columns} FROM credit_remote_sale_confirm_prototype WHERE operation_id=?`,entry.operationId);
 if(!row||row.acknowledged!==0||entry.kind!=='sale'||entry.entityId!==row.invoiceId||entry.commercialId!==identity.commercialId||entry.payload!==row.payload||entry.recordedAt!==row.recordedAt)throw Error('Révision modifiée : abandon refusé.');
 const {event}=parse(row,identity),r=response&&typeof response==='object'&&!Array.isArray(response)?response as Record<string,unknown>:null;
 if(!r||r.status!=='abandoned'||r.operationId!==entry.operationId||r.saleId!==entry.entityId||r.version!==event.version||Object.keys(r).sort().join(',')!=='operationId,saleId,status,version')throw Error('Accusé d’abandon invalide.');
 await saveVerifiedCreditReference(tx,identity,verified,reference,digest);
 await tx.runAsync('INSERT INTO credit_remote_sale_abandoned_prototype(operation_id,server_receipt,confirmed_at) VALUES(?,?,?)',entry.operationId,canonicalJson(r),new Date().toISOString());
 await tx.runAsync('UPDATE credit_remote_sale_confirm_prototype SET acknowledged=2 WHERE operation_id=?',entry.operationId);
 await tx.runAsync('DELETE FROM credit_remote_sale_draft_prototype WHERE operation_id=?',entry.operationId);
 await tx.runAsync('DELETE FROM credit_remote_sale_failure_prototype WHERE operation_id=?',entry.operationId);
 await tx.runAsync('DELETE FROM credit_sources_prototype_cache WHERE client_id=?',row.clientId);
 const balance=await readPrototypeCreditBalance(tx,identity,row.clientId,digest);if(balance.conflict)throw Error('Solde en conflit : rapprochement nécessaire.');
 return {operationId:entry.operationId};
}

/** Comparaison informative d'une révision non acquittée, sans fusion ni
 * mutation durable. Les deux réponses authentifiées doivent correspondre au
 * même instantané ; toute divergence impose une nouvelle lecture en ligne. */
export async function comparePendingRemoteEditPrototype(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,operationId:string,referenceValue:unknown,sourcesValue:unknown,digest:(text:string)=>Promise<string>){
 await bound(tx,identity);const row=await tx.getFirstAsync<Row>(`SELECT ${columns} FROM credit_remote_sale_confirm_prototype WHERE operation_id=?`,operationId);
 if(!row||row.acknowledged!==0)throw Error('Modification en attente introuvable ou déjà acquittée.');
 const {request,original,revised}=parse(row,identity);
 if(await digest(canonicalJson(original))!==request.key.hash)throw Error('Empreinte de la version d’origine incohérente.');
 // Le cache existant contrôle le non-retour en arrière, mais la comparaison ne
 // change rien à la référence réellement utilisée par les écritures locales.
 await tx.runAsync('SAVEPOINT remote_compare');
 try{
  const reference=await saveVerifiedCreditReference(tx,identity,verified,referenceValue,digest);
  const state=reference.saleStates.find(s=>s.saleId===row.invoiceId);
  if(!state||state.clientId!==row.clientId||state.version<original.syncVersion)throw Error('Facture absente ou référence périmée.');
  const sources=await validateCreditSources(sourcesValue,reference,row.clientId,digest);
  const item=sources.items.find(i=>i.kind==='sale'&&i.invoiceId===row.invoiceId);
  let current:SavedSale|null=null;
  if(state.creditNote){if(item)throw Error('Facture annulée incohérente.');}
  else{
   if(!item||item.version!==state.version)throw Error('Version actuelle indisponible : réessayez.');
   current=validateRemoteSaleSourcePrototype(item.source);
   if(current.syncSaleId!==row.invoiceId||current.clientId!==row.clientId||current.syncVersion!==state.version)throw Error('Version actuelle incohérente.');
  }
  return {operationId:row.operationId,invoiceId:row.invoiceId,clientId:row.clientId,recordedAt:row.recordedAt,
   original:validateRemoteSaleSourcePrototype(original),proposed:validateRemoteSaleSourcePrototype(revised),current,
   currentVersion:state.version,cancelled:!!state.creditNote,refund:request.preview.refund as number,retainedCredit:request.preview.credit as number};
 }finally{await tx.runAsync('ROLLBACK TO remote_compare');await tx.runAsync('RELEASE remote_compare');}
}

/** Archive locale indicative des demandes expressément abandonnées : ce ne
 * sont ni des ventes enregistrées, ni des remboursements enregistrés. */
export async function readAbandonedRemoteEditsPrototype(tx:Tx,identity:DeviceIdentity,clientId:string,digest:(text:string)=>Promise<string>){
 await bound(tx,identity);
 const rows=await tx.getAllAsync<Row>(`SELECT ${columns} FROM credit_remote_sale_confirm_prototype WHERE client_id=? AND EXISTS(SELECT 1 FROM credit_remote_sale_abandoned_prototype a WHERE a.operation_id=credit_remote_sale_confirm_prototype.operation_id) ORDER BY rowid DESC LIMIT 100`,clientId);
 const result=[];
 for(const row of rows){
  const {request,original,revised,event}=parse(row,identity);
  const receipt=await tx.getFirstAsync<{value:string;confirmedAt:string}>('SELECT server_receipt AS value,confirmed_at AS confirmedAt FROM credit_remote_sale_abandoned_prototype WHERE operation_id=?',row.operationId);
  let r:Record<string,unknown>;try{r=JSON.parse(receipt?.value??'');}catch{throw Error('Accusé d’abandon illisible.');}
  const time=new Date(receipt?.confirmedAt??'');
  if(row.acknowledged!==2||!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).sort().join(',')!=='operationId,saleId,status,version'||r.status!=='abandoned'||r.operationId!==row.operationId||r.saleId!==row.invoiceId||r.version!==event.version||!Number.isFinite(time.getTime())||time.toISOString()!==receipt?.confirmedAt||await digest(canonicalJson(original))!==request.key.hash)throw Error('Archive d’abandon incohérente.');
  result.push({operationId:row.operationId,invoiceId:row.invoiceId,recordedAt:row.recordedAt,confirmedAt:receipt.confirmedAt,original:validateRemoteSaleSourcePrototype(original),proposed:validateRemoteSaleSourcePrototype(revised),refund:request.preview.refund as number,retainedCredit:request.preview.credit as number});
 }
 return result;
}

/** Prouve qu'une révision a bien été reçue, même si une autre version ou un
 * avoir l'a ensuite remplacée. Reçu et référence proviennent d'un instantané
 * serveur unique. Toute écriture locale doit être dans la transaction exclusive. */
export async function recoverReceivedRemoteEditPrototype(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,operationId:string,value:unknown,digest:(text:string)=>Promise<string>){
 await bound(tx,identity);
 const row=await tx.getFirstAsync<Row>(`SELECT ${columns} FROM credit_remote_sale_confirm_prototype WHERE operation_id=?`,operationId);
 if(!row||![0,1].includes(row.acknowledged))throw Error('Révision en attente introuvable ou déjà vérifiée.');
 const {event,revised}=parse(row,identity),response=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
 if(!response||Object.keys(response).sort().join(',')!=='commercialId,event,reference,status'||response.status!=='received'||response.commercialId!==identity.commercialId||canonicalJson(response.event)!==canonicalJson({...event,recordedAt:row.recordedAt}))throw Error('Preuve de révision différente ou invalide.');
 const reference=await saveVerifiedCreditReference(tx,identity,verified,response.reference,digest),state=reference.saleStates.find(s=>s.saleId===row.invoiceId);
 if(!state||state.clientId!==row.clientId||state.version<event.version)throw Error('Référence antérieure ou facture différente.');
 const proof=state.creditNote?reference.saleProofs.find(p=>p.saleId===row.invoiceId):reference.eligibleSaleProofs.find(p=>p.saleId===row.invoiceId);
 const lastVersion=state.creditNote?state.creditNote.command.expectedVersion:state.version;
 if(!proof||lastVersion<event.version||proof.version!==lastVersion||(lastVersion===event.version&&await digest(canonicalJson(revised))!==proof.hash))throw Error('Historique ou preuve de vente incohérent.');
 const receipt={status:response.status,commercialId:response.commercialId,event:response.event};
 await tx.runAsync('INSERT INTO credit_remote_sale_receipt_prototype(operation_id,receipt,reference_version,confirmed_at) VALUES(?,?,?,?)',operationId,canonicalJson(receipt),state.version,new Date().toISOString());
 await tx.runAsync('UPDATE credit_remote_sale_confirm_prototype SET acknowledged=2 WHERE operation_id=?',operationId);
 await tx.runAsync('DELETE FROM credit_remote_sale_draft_prototype WHERE operation_id=?',operationId);
 await tx.runAsync('DELETE FROM credit_remote_sale_failure_prototype WHERE operation_id=?',operationId);
 await tx.runAsync('DELETE FROM credit_sources_prototype_cache WHERE client_id=?',row.clientId);
 if((await readPrototypeCreditBalance(tx,identity,row.clientId,digest)).conflict)throw Error('Solde en conflit : rapprochement nécessaire.');
 return {operationId,status:state.creditNote?'cancelled' as const:state.version>event.version?'superseded' as const:'current' as const,currentVersion:state.version};
}

/** Reçus de révisions vérifiées par le parcours de récupération. Ils restent
 * historiques : une version plus récente peut encore arriver depuis. */
export async function readRecoveredRemoteEditsPrototype(tx:Tx,identity:DeviceIdentity,clientId:string,digest:(text:string)=>Promise<string>){
 await bound(tx,identity);
 const rows=await tx.getAllAsync<Row>(`SELECT ${columns} FROM credit_remote_sale_confirm_prototype WHERE client_id=? AND EXISTS(SELECT 1 FROM credit_remote_sale_receipt_prototype r WHERE r.operation_id=credit_remote_sale_confirm_prototype.operation_id) ORDER BY rowid DESC LIMIT 100`,clientId);
 const result=[];
 for(const row of rows){
  const {request,original,revised,event}=parse(row,identity);
  const receipt=await tx.getFirstAsync<{value:string;referenceVersion:number;confirmedAt:string}>('SELECT receipt AS value,reference_version AS referenceVersion,confirmed_at AS confirmedAt FROM credit_remote_sale_receipt_prototype WHERE operation_id=?',row.operationId);
  let r:Record<string,unknown>;try{r=JSON.parse(receipt?.value??'');}catch{throw Error('Preuve de révision illisible.');}
  const time=new Date(receipt?.confirmedAt??'');
  if(row.acknowledged!==2||!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).sort().join(',')!=='commercialId,event,status'||r.status!=='received'||r.commercialId!==identity.commercialId||canonicalJson(r.event)!==canonicalJson({...event,recordedAt:row.recordedAt})||!Number.isSafeInteger(receipt?.referenceVersion)||receipt!.referenceVersion<event.version||!Number.isFinite(time.getTime())||time.toISOString()!==receipt?.confirmedAt||await digest(canonicalJson(original))!==request.key.hash)throw Error('Preuve de révision incohérente.');
  result.push({operationId:row.operationId,invoiceId:row.invoiceId,recordedAt:row.recordedAt,confirmedAt:receipt.confirmedAt,referenceVersion:receipt.referenceVersion,original:validateRemoteSaleSourcePrototype(original),revised:validateRemoteSaleSourcePrototype(revised),refund:request.preview.refund as number,retainedCredit:request.preview.credit as number});
 }
 return result;
}
