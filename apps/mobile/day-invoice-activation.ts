/** Transition explicite depuis la référence individuelle existante. Les données
 * locales restent en place ; l'ancien parcours devient incompatible avec le
 * cache v6. L'appelant doit détenir une transaction SQLite exclusive. */
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import type {LineagePin} from './server-lineage-proof';
import {previewDayInvoiceMigration} from './day-invoice-migration-preview';
import {saveDayInvoiceReference,readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export const dayInvoiceBindingSchema=`CREATE TABLE IF NOT EXISTS day_invoice_binding (
 id INTEGER PRIMARY KEY CHECK(id=1), commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL,
 lineage_id TEXT NOT NULL, commercial_name TEXT NOT NULL
);`;
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
export type DayInvoiceBinding={identity:DeviceIdentity;pin:LineagePin;name:string};
export async function readDayInvoiceBinding(tx:Tx):Promise<DayInvoiceBinding|null>{
 const row=await tx.getFirstAsync<{commercialId:string;serverOrigin:string;lineageId:string;name:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,lineage_id AS lineageId,commercial_name AS name FROM day_invoice_binding WHERE id=1');
 const cache=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM day_invoice_reference_cache) AS n');
 if(!cache||![0,1].includes(cache.n))throw Error('État facture du jour indisponible.');
 if(!row){if(cache.n)throw Error('Référence facture du jour sans liaison : rapprochement nécessaire.');return null;}
 const identity=await getDeviceIdentity(tx);
 if(!identity||row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin||!uuid(row.lineageId)||typeof row.name!=='string'||!row.name.trim()||row.name.length>200||!cache.n)throw Error('Liaison facture du jour incohérente.');
 const ref=await readDayInvoiceReferenceCache(tx,identity);if(!ref)throw Error('Référence facture du jour indisponible.');
 return {identity,pin:{...identity,lineageId:row.lineageId},name:row.name};
}
export async function activateDayInvoiceBinding(tx:Tx,identity:DeviceIdentity,pin:LineagePin,name:string,reference:unknown,digest:(s:string)=>Promise<string>,check:()=>void){
 check();if(!uuid(pin.lineageId)||pin.commercialId!==identity.commercialId||pin.serverOrigin!==identity.serverOrigin||typeof name!=='string'||!name.trim()||name.length>200)throw Error('Liaison invalide.');
 if(await readDayInvoiceBinding(tx))throw Error('Facture du jour déjà activée.');
 const report=await previewDayInvoiceMigration(tx,identity,identity,reference,digest,check);
 if(report.pendingOperations||report.conflictingClientIds.length)throw Error('Opérations en attente ou clients en conflit : synchronisez et rapprochez avant le passage.');
 if(!report.localInventory.expenses.available||!report.localInventory.closures.available)throw Error('Inventaire des dépenses ou clôtures indisponible.');
 // L'écran v6 ne gère pas encore les dépenses ; ne pas masquer leur historique.
 if(report.localInventory.expenses.originals||report.localInventory.expenses.revisions||report.localInventory.expenses.cancellations)throw Error('Dépenses présentes : raccordement nécessaire avant le passage.');
 if(report.localInventory.closures.closing)throw Error('Clôture en attente : répondez ou abandonnez avant le passage.');
 await saveDayInvoiceReference(tx,identity,identity,reference);check();
 const cached=await readDayInvoiceReferenceCache(tx,identity);if(!cached?.hasClientStatuses)throw Error('Statuts clients absents : mise à jour du serveur nécessaire.');
 await tx.runAsync('INSERT INTO day_invoice_binding(id,commercial_id,server_origin,lineage_id,commercial_name) VALUES(1,?,?,?,?)',identity.commercialId,identity.serverOrigin,pin.lineageId,name.trim());
 check();const result=await readDayInvoiceBinding(tx);if(!result)throw Error('Liaison indisponible.');return result;
}
