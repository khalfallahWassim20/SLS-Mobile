/** Dernière barrière v5 : solde et journal vérifiés dans la transaction qui
 * prépare (ou reprend) une clôture. Non utilisée par le protocole historique. */
import type {DeviceIdentity} from './identified-device';
import {readPrototypeCreditReferenceCache} from './credit-note-reference-cache-prototype';
import {saveAndVerifyFinalCreditReference} from './credit-note-sync-final-prototype';
import {readCreditJournalExportPrototype} from './credit-note-journal-export-prototype';
import {findTourCloseAttempt} from './tour-close-queue';
import {preparePrototypeClose} from './credit-note-close-prototype';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export async function prepareVerifiedPrototypeClose(tx:Tx,identity:DeviceIdentity,day:string,version:number,uuid:()=>string,digest:(data:string)=>Promise<string>){
 const reference=await readPrototypeCreditReferenceCache(tx,identity);if(!reference)throw Error('Référence v5 indisponible : synchronisez avant clôture.');
 await saveAndVerifyFinalCreditReference(tx,identity,identity,reference,digest);
 const journal=await readCreditJournalExportPrototype(tx,identity,day,'Contrôle de clôture',digest);
 const previous=await findTourCloseAttempt(tx,identity.commercialId,day);
 // Une demande ancienne sans preuve peut déjà avoir été reçue : ne jamais
 // changer son contenu pendant une reprise dont la réponse a été perdue.
 if(!previous&&reference.cashAssignments===null)throw Error('Attributions de caisse indisponibles : synchronisez avant clôture.');
 const attempt=await preparePrototypeClose(tx,identity,day,version,uuid);
 if(previous)return attempt;
 const proof=(journal.adminCreditRefunds??[]).map(r=>({noteOperationId:r.noteOperationId,assignmentId:r.assignmentId,refund:r.refund})).sort((a,b)=>a.noteOperationId<b.noteOperationId?-1:a.noteOperationId>b.noteOperationId?1:0);
 if(proof.length>10000)throw Error('Trop d’attributions de caisse pour clôturer.');
 await tx.runAsync('INSERT INTO tour_close_admin_refund_proofs(request_id,payload) VALUES(?,?)',attempt.requestId,JSON.stringify(proof));
 return {...attempt,adminRefundProof:proof};
}
