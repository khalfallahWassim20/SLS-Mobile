/** Dernière barrière v5 : solde et journal vérifiés dans la transaction qui
 * prépare (ou reprend) une clôture. Non utilisée par le protocole historique. */
import type {DeviceIdentity} from './identified-device';
import {readPrototypeCreditReferenceCache} from './credit-note-reference-cache-prototype';
import {saveAndVerifyFinalCreditReference} from './credit-note-sync-final-prototype';
import {readCreditJournalExportPrototype} from './credit-note-journal-export-prototype';
import {preparePrototypeClose} from './credit-note-close-prototype';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export async function prepareVerifiedPrototypeClose(tx:Tx,identity:DeviceIdentity,day:string,version:number,uuid:()=>string,digest:(data:string)=>Promise<string>){
 const reference=await readPrototypeCreditReferenceCache(tx,identity);if(!reference)throw Error('Référence v5 indisponible : synchronisez avant clôture.');
 await saveAndVerifyFinalCreditReference(tx,identity,identity,reference,digest);
 await readCreditJournalExportPrototype(tx,identity,day,'Contrôle de clôture',digest);
 return preparePrototypeClose(tx,identity,day,version,uuid);
}
