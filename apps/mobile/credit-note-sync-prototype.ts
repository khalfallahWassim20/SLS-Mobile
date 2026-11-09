/** Synchronisation préparatoire non branchée aux écrans ni à l'API active.
 * Les callbacks de lecture et d'accusé doivent chacun utiliser une transaction
 * SQLite exclusive ; saveReference doit utiliser saveVerifiedCreditReference. */
import {uploadIdentifiedOperations,type IdentifiedEntry} from './identified-upload';
import {uploadPrototypeCreditNotes} from './credit-note-upload-prototype';
import type {DeviceIdentity} from './identified-device';
import type {Note} from './credit-note-offline-prototype';

type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
type IO={
 readOperations:()=>Promise<IdentifiedEntry[]>;
 acknowledgeOperation:(entry:IdentifiedEntry)=>Promise<void>;
 readReadyCredits:()=>Promise<Note[]>;
 readAllCredits:()=>Promise<{note:Note;pending:boolean}[]>;
 acknowledgeCredit:(note:Note,response:unknown)=>Promise<void>;
 sendOperation:(path:string,body:string)=>Promise<Response>;
 sendCredit:(path:string,body:string)=>Promise<Response>;
 fetchReference:()=>Promise<unknown>;
 saveReference:(identity:DeviceIdentity,verified:DeviceIdentity,value:unknown)=>Promise<void>;
};
const uuid=(v:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
/** N'efface que les opérations explicitement acquittées. Toute erreur interrompt
 * la suite sans supprimer les autres éléments ; il faut réessayer avec la même
 * identité. La référence finale est obligatoire avant d'annoncer une réussite. */
export async function syncCreditPrototype(identity:DeviceIdentity,verified:DeviceIdentity,io:IO) {
 if(!uuid(identity.commercialId)||identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur différent du téléphone lié.');
 await io.saveReference(identity,verified,await io.fetchReference());
 const entries=await io.readOperations(),byId=new Map(entries.map(e=>[e.operationId,e]));
 const operations=await uploadIdentifiedOperations(entries,identity,verified,io.sendOperation,async(id,kind)=>{
  const entry=byId.get(id);
  if(!entry||entry.kind!==kind)throw Error('Opération en attente introuvable.');
  await io.acknowledgeOperation(entry);
 });
 const notes=await io.readReadyCredits();
 const credits=await uploadPrototypeCreditNotes(notes,identity,verified,io.sendCredit,io.acknowledgeCredit);
 if((await io.readAllCredits()).some(n=>n.pending))throw Error('Un avoir reste en attente : synchronisation incomplète.');
 if((await io.readOperations()).length)throw Error('Une opération reste en attente : synchronisation incomplète.');
 await io.saveReference(identity,verified,await io.fetchReference());
 return {operations,credits};
}
