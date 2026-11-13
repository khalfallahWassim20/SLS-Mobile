/** Prototype NON raccordé à l'interface. Cette fonction ne prouve pas qu'un
 * serveur est légitime. L'appelant futur devra d'abord vérifier une preuve
 * d'autorisation fiable et la lignée enregistrée avant le changement d'adresse.
 * Appeler dans une transaction SQLite exclusive, sans synchronisation en cours. */
import {apiOrigin} from './commercial-login';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {canonicalJson} from '@sls/domain';
import {validateOfflineCreditRow,type LocalRow} from './credit-note-offline-prototype';
import {validateRemoteSaleConfirm,type RemoteSaleConfirmRow} from './credit-remote-sale-confirm-prototype';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
const columnTables=['identified_device','credit_protocol_quarantine','identified_reference_cache','credit_reference_prototype_cache','credit_sources_prototype_cache','offline_credit_prototype','credit_abandoned_note_prototype','credit_remote_sale_draft_prototype','credit_remote_sale_confirm_prototype'] as const;
const simpleTables=['credit_protocol_quarantine','identified_reference_cache','credit_reference_prototype_cache','credit_sources_prototype_cache'] as const;
const identifier=(name:string)=>'"'+name.replace(/"/g,'""')+'"';

/** Préserve toutes les opérations et vérifie tout avant écriture. Le savepoint
 * annule même une erreur tardive ; la transaction externe doit être exclusive. */
export async function migrateDeviceOriginPrototype(tx:Tx,old:DeviceIdentity,newOrigin:string):Promise<void> {
 const target=apiOrigin(newOrigin);
 if(apiOrigin(old.serverOrigin)!==old.serverOrigin||target!==newOrigin||target===old.serverOrigin)throw Error('Origines invalides ou identiques.');
 await tx.runAsync('SAVEPOINT server_address_migration');
 try {
  const bound=await getDeviceIdentity(tx);
  if(!bound||bound.commercialId!==old.commercialId||bound.serverOrigin!==old.serverOrigin)throw Error('Liaison du téléphone modifiée : opération annulée.');
  const tables=await tx.getAllAsync<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  const names=new Set(tables.map(t=>t.name));
  for(const name of columnTables)if(!names.has(name))throw Error('Schéma mobile incomplet : rapprochement nécessaire.');
  for(const table of tables){
   const columns=await tx.getAllAsync<{name:string}>(`PRAGMA table_info(${identifier(table.name)})`);
   if(columns.some(c=>c.name.toLowerCase()==='server_origin')&&!columnTables.some(t=>t===table.name))throw Error('Nouvelle table liée au serveur : rapprochement nécessaire.');
  }
  for(const table of columnTables){
   const incompatible=await tx.getFirstAsync<{n:number}>(`SELECT count(*) AS n FROM ${identifier(table)} WHERE commercial_id<>? OR server_origin<>? OR commercial_id IS NULL OR server_origin IS NULL`,old.commercialId,old.serverOrigin);
   if(!incompatible||incompatible.n!==0)throw Error('Données liées à une autre identité : rapprochement nécessaire.');
  }
  // Les documents contenant une identité sont examinés individuellement ;
  // seul le champ d'adresse est changé, jamais les événements ou les reçus.
  const destination={commercialId:old.commercialId,serverOrigin:target};
  const notes=await tx.getAllAsync<LocalRow>(`SELECT operation_id AS operationId,invoice_id AS invoiceId,kind,commercial_id AS commercialId,server_origin AS serverOrigin,payload,pending FROM offline_credit_prototype ORDER BY rowid`);
  for(const row of notes){
   const note=validateOfflineCreditRow(row,old),updated={...note,serverOrigin:target},payload=canonicalJson(updated);
   validateOfflineCreditRow({...row,serverOrigin:target,payload},destination);
   await tx.runAsync('UPDATE offline_credit_prototype SET server_origin=?,payload=? WHERE operation_id=?',target,payload,row.operationId);
  }
  const archives=await tx.getAllAsync<{operationId:string;commercialId:string;serverOrigin:string;payload:string;receipt:string;abandonedAt:string}>(`SELECT operation_id AS operationId,commercial_id AS commercialId,server_origin AS serverOrigin,payload,receipt,abandoned_at AS abandonedAt FROM credit_abandoned_note_prototype ORDER BY rowid`);
  for(const row of archives){
   let raw:any,receipt:any;try{raw=JSON.parse(row.payload);receipt=JSON.parse(row.receipt);}catch{throw Error('Archive d’avoir illisible.');}
   const local={payload:row.payload,commercialId:row.commercialId,serverOrigin:row.serverOrigin,kind:raw?.kind,invoiceId:raw?.command?.invoiceId,operationId:row.operationId,pending:1};
   const note=validateOfflineCreditRow(local,old);
   if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||Object.keys(receipt).sort().join(',')!=='invoiceId,kind,operationId,status'||receipt.status!=='abandoned'||receipt.kind!==note.kind||receipt.operationId!==row.operationId||receipt.invoiceId!==note.command.invoiceId||!Number.isFinite(Date.parse(row.abandonedAt))||new Date(row.abandonedAt).toISOString()!==row.abandonedAt)throw Error('Archive d’avoir incohérente.');
   const payload=canonicalJson({...note,serverOrigin:target});validateOfflineCreditRow({...local,serverOrigin:target,payload},destination);
   await tx.runAsync('UPDATE credit_abandoned_note_prototype SET server_origin=?,payload=? WHERE operation_id=?',target,payload,row.operationId);
  }
  const confirms=await tx.getAllAsync<RemoteSaleConfirmRow>(`SELECT operation_id AS operationId,invoice_id AS invoiceId,client_id AS clientId,commercial_id AS commercialId,server_origin AS serverOrigin,recorded_at AS recordedAt,request,original,revised,payload,acknowledged FROM credit_remote_sale_confirm_prototype ORDER BY rowid`);
  for(const row of confirms){
   const {request}=validateRemoteSaleConfirm(row,old);request.context.identity.serverOrigin=target;
   const content=canonicalJson(request);validateRemoteSaleConfirm({...row,serverOrigin:target,request:content},destination);
   await tx.runAsync('UPDATE credit_remote_sale_confirm_prototype SET server_origin=?,request=? WHERE operation_id=?',target,content,row.operationId);
  }
  const drafts=await tx.getAllAsync<{operationId:string;invoiceId:string;request:string;preview:string}>(`SELECT operation_id AS operationId,invoice_id AS invoiceId,request,preview FROM credit_remote_sale_draft_prototype ORDER BY rowid`);
  for(const row of drafts){
   let request:any,preview:any;try{request=JSON.parse(row.request);preview=JSON.parse(row.preview);}catch{throw Error('Brouillon illisible.');}
   if(!request||request.operationId!==row.operationId||request.key?.invoiceId!==row.invoiceId||request.context?.identity?.commercialId!==old.commercialId||request.context?.identity?.serverOrigin!==old.serverOrigin||canonicalJson(request.preview)!==canonicalJson(preview))throw Error('Brouillon incohérent.');
   const match=confirms.find(c=>c.operationId===row.operationId);
   if(match&&match.request!==row.request)throw Error('Brouillon et révision incohérents.');
   request.context.identity.serverOrigin=target;
   await tx.runAsync('UPDATE credit_remote_sale_draft_prototype SET server_origin=?,request=? WHERE operation_id=?',target,canonicalJson(request),row.operationId);
  }
  for(const table of simpleTables)await tx.runAsync(`UPDATE ${identifier(table)} SET server_origin=? WHERE commercial_id=? AND server_origin=?`,target,old.commercialId,old.serverOrigin);
  await tx.runAsync('UPDATE identified_device SET server_origin=? WHERE id=1 AND commercial_id=? AND server_origin=?',target,old.commercialId,old.serverOrigin);
  const result=await getDeviceIdentity(tx);
  if(!result||result.commercialId!==old.commercialId||result.serverOrigin!==target)throw Error('Liaison non modifiée.');
  await tx.runAsync('RELEASE SAVEPOINT server_address_migration');
 }catch(e){await tx.runAsync('ROLLBACK TO SAVEPOINT server_address_migration');await tx.runAsync('RELEASE SAVEPOINT server_address_migration');throw e;}
}
