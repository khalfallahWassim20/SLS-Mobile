/** Réception préparatoire : exécuter dans une transaction SQLite exclusive.
 * Ne pas activer tant que le protocole complet et les écrans ne sont pas prêts. */
import {canonicalJson,prepareFullCreditNote} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import {readAllOfflineCreditPrototype} from './credit-note-offline-prototype';
import {savePrototypeCreditReference} from './credit-note-reference-cache-prototype';
import {validatePrototypeCreditReference} from './credit-note-reference-prototype';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
/** Une réponse retardée ne peut pas faire disparaître un avoir déjà acquitté.
 * La commande, l'acteur et la preuve du contenu d'origine doivent correspondre.
 * Un avoir encore en attente peut être absent : il sera rejoué idempotemment. */
export async function saveVerifiedCreditReference(tx:Tx,identity:DeviceIdentity,verified:DeviceIdentity,value:unknown,digest:(data:string)=>Promise<string>) {
 const reference=validatePrototypeCreditReference(value);
 const notes=await readAllOfflineCreditPrototype(tx,identity);
 for(const {note,pending} of notes){
  if(pending)continue;
  const source=note.source as Record<string,any>,actor={id:identity.commercialId,role:'commercial' as const};
  if(note.kind==='sale'){
   const state=reference.saleStates.find(s=>s.saleId===note.command.invoiceId);
   const proof=reference.saleProofs.find(p=>p.saleId===note.command.invoiceId);
   const expected=prepareFullCreditNote({actor,command:note.command,source:{invoiceId:note.command.invoiceId,version:note.command.expectedVersion,total:source.total,netPaid:source.paid,cancelled:false},daysOpen:true,previous:null}).event;
   if(!state?.creditNote||state.clientId!==source.clientId||canonicalJson(state.creditNote)!==canonicalJson(expected)||!proof||proof.version!==note.command.expectedVersion||await digest(canonicalJson(source))!==proof.hash)throw Error('Référence sans avoir de vente déjà confirmé.');
  }else{
   const state=reference.journalStates.find(s=>s.id===note.command.invoiceId),proof=reference.journalProofs.find(p=>p.id===note.command.invoiceId),command=note.command;
   const expected={operationId:command.operationId,expectedVersion:command.expectedVersion,choice:command.choice,recordedAt:command.recordedAt,actor};
   if(!state?.creditNote||state.clientId!==source.invoice?.clientId||canonicalJson(state.creditNote)!==canonicalJson(expected)||!proof||proof.version!==command.expectedVersion||await digest(canonicalJson(source))!==proof.hash)throw Error('Référence sans avoir préétabli déjà confirmé.');
  }
 }
 await savePrototypeCreditReference(tx,identity,verified,reference);
 return reference;
}
