/** Prototype NON raccordé à l'interface. Cette fonction ne prouve pas qu'un
 * serveur est légitime. L'appelant futur devra d'abord vérifier une preuve
 * d'autorisation fiable et la lignée enregistrée avant le changement d'adresse.
 * Appeler dans une transaction SQLite exclusive, sans synchronisation en cours. */
import {apiOrigin} from './commercial-login';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
const columnTables=['identified_device','credit_protocol_quarantine','identified_reference_cache','credit_reference_prototype_cache','credit_sources_prototype_cache','offline_credit_prototype','credit_abandoned_note_prototype','credit_remote_sale_draft_prototype','credit_remote_sale_confirm_prototype'] as const;
// Ces tables possèdent aussi des identités imbriquées dans des documents JSON.
// Aucune réécriture heuristique : si elles contiennent de l'historique ou des
// demandes, le rapprochement manuel reste obligatoire, même si déjà envoyées.
const complexTables=['offline_credit_prototype','credit_abandoned_note_prototype','credit_remote_sale_draft_prototype','credit_remote_sale_confirm_prototype'] as const;
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
  for(const table of complexTables){
   const count=await tx.getFirstAsync<{n:number}>(`SELECT count(*) AS n FROM ${identifier(table)}`);
   if(!count||count.n!==0)throw Error('Historique ou opération v5 présent : rapprochement nécessaire.');
  }
  for(const table of simpleTables)await tx.runAsync(`UPDATE ${identifier(table)} SET server_origin=? WHERE commercial_id=? AND server_origin=?`,target,old.commercialId,old.serverOrigin);
  await tx.runAsync('UPDATE identified_device SET server_origin=? WHERE id=1 AND commercial_id=? AND server_origin=?',target,old.commercialId,old.serverOrigin);
  const result=await getDeviceIdentity(tx);
  if(!result||result.commercialId!==old.commercialId||result.serverOrigin!==target)throw Error('Liaison non modifiée.');
  await tx.runAsync('RELEASE SAVEPOINT server_address_migration');
 }catch(e){await tx.runAsync('ROLLBACK TO SAVEPOINT server_address_migration');await tx.runAsync('RELEASE SAVEPOINT server_address_migration');throw e;}
}
