/** Capture v5 de l'espace commercial, préparatoire et non montée dans App.tsx.
 * L'appelant maintient la même transaction SQLite jusqu'à la fin. */
import type {DeviceIdentity} from './identified-device';
import {readCreditClientsPrototype} from './credit-client-view-prototype';
import {readCreditJournalExportPrototype} from './credit-note-journal-export-prototype';
import {describeCreditJournalPrototype} from './credit-note-journal-view-model-prototype';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
export async function readCreditMobileWorkspacePrototype(tx:Tx,identity:DeviceIdentity,day:string,commercial:string,digest:(text:string)=>Promise<string>){
 const clients=await readCreditClientsPrototype(tx,identity,digest);
 const journal=await readCreditJournalExportPrototype(tx,identity,day,commercial,digest);
 return {identity:{...identity},clients,journal,view:describeCreditJournalPrototype(journal)};
}
