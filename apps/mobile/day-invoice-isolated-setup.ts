/** Liaison du banc v6 isolé uniquement. Appeler dans une transaction SQLite
 * exclusive ; ne jamais utiliser pour migrer le téléphone commercial réel. */
import {apiOrigin} from './commercial-login';
import {bindVerifiedDevice,getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {saveDayInvoiceReference} from './day-invoice-reference-cache';
import type {LineagePin} from './server-lineage-proof';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export type IsolatedSetup={identity:DeviceIdentity;pin:LineagePin;name:string};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const isolatedDayInvoiceSetupSchema=`CREATE TABLE IF NOT EXISTS day_invoice_isolated_setup (
 id INTEGER PRIMARY KEY CHECK(id=1), commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL, lineage_id TEXT NOT NULL, commercial_name TEXT NOT NULL
);`;
function validate(setup:IsolatedSetup){
 const {identity,pin,name}=setup;
 if(!identity||!pin||!uuid(identity.commercialId)||!uuid(pin.lineageId)||identity.commercialId!==pin.commercialId||identity.serverOrigin!==pin.serverOrigin||typeof name!=='string'||!name.trim()||name.length>200||apiOrigin(identity.serverOrigin)!==identity.serverOrigin)throw Error('Liaison de test invalide.');
}
export async function readIsolatedDayInvoiceSetup(tx:Tx):Promise<IsolatedSetup|null>{
 const identity=await getDeviceIdentity(tx),row=await tx.getFirstAsync<{commercialId:string;serverOrigin:string;lineageId:string;name:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,lineage_id AS lineageId,commercial_name AS name FROM day_invoice_isolated_setup WHERE id=1');
 if(!identity&&!row)return null;if(!identity||!row)throw Error('Liaison de test incomplète : rapprochement nécessaire.');
 const result={identity:{commercialId:identity.commercialId,serverOrigin:identity.serverOrigin},pin:{commercialId:row.commercialId,serverOrigin:row.serverOrigin,lineageId:row.lineageId},name:row.name};validate(result);return result;
}
export function assertIsolatedDayInvoicePin(saved:IsolatedSetup,candidate:LineagePin){
 validate(saved);if(candidate.commercialId!==saved.pin.commercialId||candidate.serverOrigin!==saved.pin.serverOrigin||candidate.lineageId!==saved.pin.lineageId)throw Error('Lignée serveur différente : aucune opération envoyée.');
}
/** Première liaison seulement sur stockage isolé vide ; la référence et la
 * lignée sont enregistrées atomiquement, sans écraser une liaison existante. */
export async function initializeIsolatedDayInvoice(tx:Tx,setup:IsolatedSetup,reference:unknown,check:()=>void){
 validate(setup);check();const previous=await readIsolatedDayInvoiceSetup(tx);if(previous)throw Error('Liaison de test déjà initialisée.');
 // Examiner tous les registres présents, y compris les nouveaux registres futurs
 // ou orphelins. Une liste figée oublierait les tentatives et files v6.
 // sqlite_* et android_metadata sont des tables techniques du moteur.
 const tables=await tx.getAllAsync<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name<>'android_metadata'");
 if(!Array.isArray(tables)||!tables.length)throw Error('Inventaire du stockage indisponible.');
 for(const table of tables){
  if(typeof table.name!=='string'||!table.name||table.name.includes('\0'))throw Error('Inventaire du stockage invalide.');
  const quoted='"'+table.name.replace(/"/g,'""')+'"';
  const state=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM ${quoted}) AS n`);
  if(!state||state.n!==0)throw Error('Stockage de test non vide : aucune liaison effectuée.');
 }
 await bindVerifiedDevice(tx,setup.identity);check();await saveDayInvoiceReference(tx,setup.identity,setup.identity,reference);check();
 await tx.runAsync('INSERT INTO day_invoice_isolated_setup(id,commercial_id,server_origin,lineage_id,commercial_name) VALUES(1,?,?,?,?)',setup.identity.commercialId,setup.identity.serverOrigin,setup.pin.lineageId,setup.name);
 check();const saved=await readIsolatedDayInvoiceSetup(tx);if(!saved)throw Error('Liaison de test indisponible.');assertIsolatedDayInvoicePin(saved,setup.pin);return saved;
}
