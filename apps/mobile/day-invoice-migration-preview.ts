/** Aperçu préparatoire, non activé dans l'application : aucune migration ni
 * autorisation d'écriture. L'appelant doit ouvrir une transaction EXCLUSIVE,
 * fournir une référence reçue d'une session/lignée préalablement vérifiées et
 * vérifier cette session avant et après la capture. Les autres téléphones et
 * les changements serveur après cette capture restent inconnus. */
import type {DeviceIdentity} from './identified-device';
import {assertLegacyMobileDayInvoiceSafe} from './day-invoice-legacy-guard';
import {assertDayInvoiceAttemptExclusive} from './day-invoice-attempt-guard';
import {saveDayInvoiceReference} from './day-invoice-reference-cache';
import {readDayInvoiceClients} from './day-invoice-clients';
import {acquireDayInvoiceSync,releaseDayInvoiceSync} from './day-invoice-sync-lock';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
/** Le cache v6 est installé temporairement dans un savepoint SQLite, afin de
 * réutiliser les mêmes contrôles que les écrans v6 sans rendre ce cache visible
 * aux anciens écrans. Le retour en arrière a lieu même en cas d'erreur. Ne
 * jamais ouvrir ce savepoint hors de la transaction exclusive de l'appelant. */
export async function previewDayInvoiceMigration(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,reference:unknown,digest:(text:string)=>Promise<string>,check:()=>void){
 check();await assertLegacyMobileDayInvoiceSafe(tx);await assertDayInvoiceAttemptExclusive(tx,identity);check();
 const base=await tx.getFirstAsync<{commercialId:string;serverOrigin:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin FROM identified_reference_cache WHERE id=1');
 if(!base||base.commercialId!==identity.commercialId||base.serverOrigin!==identity.serverOrigin)throw Error('Référence individuelle antérieure indisponible : rapprochement nécessaire.');
 await tx.runAsync('SAVEPOINT day_invoice_migration_preview');
 try{
  await saveDayInvoiceReference(tx,identity,verified,reference);check();
  const snapshot=await readDayInvoiceClients(tx,identity,digest);check();
  const conflicts=snapshot.clients.filter(client=>client.conflict).map(client=>client.id);
  return {version:1 as const,clientCount:snapshot.clients.length,conflictingClientIds:conflicts,pendingOperations:snapshot.pendingOperations,
   migrationAuthorized:false as const,limitations:['autres téléphones non vérifiés','état serveur susceptible de changer','dépenses et clôtures non vérifiées','lignée et transition non autorisées par cet aperçu']};
 }finally{
  // Si le retour en arrière échoue, propager l'erreur : la transaction
  // extérieure doit alors être annulée et non validée.
  await tx.runAsync('ROLLBACK TO day_invoice_migration_preview');
  await tx.runAsync('RELEASE day_invoice_migration_preview');
 }
}

/** Orchestration de test : vérifie session et lignée avant le téléchargement,
 * puis capture localement dans une transaction exclusive. Aucun envoi, aucun
 * acquittement et aucun épinglage de première confiance ne sont effectués. */
export async function previewDayInvoiceMigrationOnline(identity:DeviceIdentity,verified:DeviceIdentity,io:{transaction:<T>(work:(tx:Tx)=>Promise<T>)=>Promise<T>;verifyServer:(identity:DeviceIdentity,check:()=>void)=>Promise<void>;fetchReference:()=>Promise<unknown>;digest:(text:string)=>Promise<string>;check:()=>void}){
 acquireDayInvoiceSync();
 try{
  const check=()=>{io.check();if(identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur différent du téléphone lié.');};
  check();await io.verifyServer(identity,check);check();const reference=await io.fetchReference();check();
  const report=await io.transaction(async tx=>{check();const value=await previewDayInvoiceMigration(tx,identity,verified,reference,io.digest,check);check();return value;});
  check();return report;
 }finally{releaseDayInvoiceSync();}
}
