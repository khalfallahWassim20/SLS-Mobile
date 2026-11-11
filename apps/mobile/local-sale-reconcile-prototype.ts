/** Application prudente d'une chaîne de versions déjà reçues sur le serveur.
 * Le cache, la vente et son historique sont modifiés dans UNE transaction
 * exclusive ; jamais de suppression ni de création d'opération à envoyer. */
import {canonicalJson} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import {saveVerifiedCreditReference} from './credit-note-sync-reference';
import {readPrototypeCreditBalance} from './credit-note-balance-storage-prototype';
import {inspectLocalSaleHistoryPrototype} from './local-sale-history-prototype';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
const object=(value:unknown):Record<string,any>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:null;
function payload(value:string,id:number){try{const v=JSON.parse(value);if(!object(v)||v.id!==id)throw Error();return v;}catch{throw Error('Historique local de vente illisible.');}}
/** L'empreinte est montrée par l'aperçu précédent et revalidée après un nouvel
 * échange en ligne ; une modification concurrente nécessite un nouvel aperçu. */
export async function reconcileLocalSalePrototype(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,localId:number,saleId:string,value:unknown,expectedFingerprint:string,digest:(text:string)=>Promise<string>){
 if(typeof expectedFingerprint!=='string'||!/^[0-9a-f]{64}$/.test(expectedFingerprint))throw Error('Aperçu de rapprochement invalide.');
 const check=await inspectLocalSaleHistoryPrototype(tx,identity,verified,localId,saleId,value,digest);
 if(check.status==='pending')throw Error('Opération ou avoir local existant : rapprochement refusé.');
 if(check.fingerprint!==expectedFingerprint)throw Error('La facture a changé depuis l’aperçu : comparez à nouveau.');
 if(check.status==='diverged')throw Error('La version locale ne correspond pas au serveur : rapprochement manuel nécessaire.');
 const localVersion=check.local.syncVersion!,events=check.events,first=events[0],missing=events.slice(localVersion);
 // Chaque version déjà locale doit avoir son historique exact et une preuve
 // d'origine : aucune version locale ne peut être silencieusement remplacée.
 const firstMarker=await tx.getFirstAsync<{commercialId:string;entityId:string;recordedAt:string}>('SELECT commercial_id AS commercialId,entity_id AS entityId,recorded_at AS recordedAt FROM identified_local_operations WHERE operation_id=? AND operation_kind=\'sale\' ',first.event.operationId);
 if(!firstMarker||firstMarker.commercialId!==identity.commercialId||firstMarker.entityId!==saleId||firstMarker.recordedAt!==first.event.recordedAt)throw Error('Origine locale de la vente non prouvée.');
 const revisions=await tx.getAllAsync<{id:number;createdAt:string;previous:string;current:string;refund:number}>('SELECT id,created_at AS createdAt,previous_payload AS previous,new_payload AS current,refund FROM sale_revisions WHERE sale_id=? ORDER BY id',localId);
 if(revisions.length!==localVersion-1)throw Error('Historique local incomplet : rapprochement manuel nécessaire.');
 for(let i=0;i<revisions.length;i++){
  const r=revisions[i],previous=events[i],next=events[i+1];
  if(canonicalJson(payload(r.previous,localId))!==canonicalJson({...previous.event.sale,id:localId})||canonicalJson(payload(r.current,localId))!==canonicalJson({...next.event.sale,id:localId})||r.createdAt!==next.event.recordedAt||r.refund!==next.event.refund)throw Error('Historique local différent du serveur.');
  const imported=await tx.getFirstAsync<{operationId:string;commercialId:string;event:string}>('SELECT operation_id AS operationId,commercial_id AS commercialId,event FROM credit_local_sale_reconcile_prototype WHERE revision_id=? AND sale_id=?',r.id,saleId);
  if(imported){
   let saved:unknown;try{saved=JSON.parse(imported.event);}catch{throw Error('Preuve locale de révision illisible.');}
   const {id:_id,...sale}=next.event.sale;
   if(imported.operationId!==next.event.operationId||imported.commercialId!==next.commercialId||canonicalJson(saved)!==canonicalJson({...next.event,sale}))throw Error('Preuve locale de révision incohérente.');
  }else{
   const marker=await tx.getFirstAsync<{commercialId:string;entityId:string;recordedAt:string}>('SELECT commercial_id AS commercialId,entity_id AS entityId,recorded_at AS recordedAt FROM identified_local_operations WHERE operation_id=? AND operation_kind=\'sale\'',next.event.operationId);
   if(!marker||marker.commercialId!==identity.commercialId||next.commercialId!==identity.commercialId||marker.entityId!==saleId||marker.recordedAt!==next.event.recordedAt)throw Error('Origine de la révision locale non prouvée.');
  }
 }
 // Un UUID déjà présent localement, y compris dans une autre file, ne peut
 // pas être réattribué à la version importée.
 for(const next of missing){
  const conflict=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM identified_local_operations WHERE operation_id=?) OR EXISTS(SELECT 1 FROM sales_outbox WHERE operation_id=?) OR EXISTS(SELECT 1 FROM journal_sync_outbox WHERE operation_id=?) OR EXISTS(SELECT 1 FROM offline_credit_prototype WHERE operation_id=?) OR EXISTS(SELECT 1 FROM credit_remote_sale_confirm_prototype WHERE operation_id=?) OR EXISTS(SELECT 1 FROM credit_local_sale_reconcile_prototype WHERE operation_id=?) OR EXISTS(SELECT 1 FROM credit_remote_sale_draft_prototype WHERE operation_id=?) OR EXISTS(SELECT 1 FROM sale_event_times WHERE operation_id=?) OR EXISTS(SELECT 1 FROM credit_abandoned_note_prototype WHERE operation_id=?) AS n`,...Array(9).fill(next.event.operationId));
  if(!conflict||conflict.n)throw Error('Identifiant de version déjà utilisé localement.');
 }
 const response=object(value);if(!response)throw Error('Référence serveur invalide.');
 await saveVerifiedCreditReference(tx,identity,verified,response.reference,digest);
 let previous={...check.local,id:localId};
 for(const next of missing){
  const revised={...next.event.sale,id:localId};
  await tx.runAsync('INSERT INTO sale_revisions(sale_id,created_at,previous_payload,new_payload,refund) VALUES(?,?,?,?,?)',localId,next.event.recordedAt,JSON.stringify(previous),JSON.stringify(revised),next.event.refund);
  const revision=await tx.getFirstAsync<{id:number}>('SELECT last_insert_rowid() AS id');if(!revision||!Number.isSafeInteger(revision.id)||revision.id<1)throw Error('Révision locale indisponible.');
  const {id:_id,...sale}=next.event.sale;
  await tx.runAsync('INSERT INTO credit_local_sale_reconcile_prototype(operation_id,revision_id,sale_id,commercial_id,event,synced_at) VALUES(?,?,?,?,?,?)',next.event.operationId,revision.id,saleId,next.commercialId,canonicalJson({...next.event,sale}),new Date().toISOString());
  previous=revised;
 }
 if(missing.length){const {id:_id,...sale}=previous;await tx.runAsync('UPDATE sales SET payload=? WHERE id=?',JSON.stringify(sale),localId);}
 await tx.runAsync('DELETE FROM credit_sources_prototype_cache WHERE client_id=?',check.clientId);
 const balance=await readPrototypeCreditBalance(tx,identity,check.clientId,digest);
 // D'autres factures du même client peuvent encore diverger : on conserve
 // cette preuve sans exposer un solde ni débloquer journal ou clôture.
 return {saleId,versionsAdded:missing.length,cancelled:check.cancelled,balance:balance.conflict?null:balance.balance};
}
