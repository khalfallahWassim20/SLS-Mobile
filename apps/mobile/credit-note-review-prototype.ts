/** Préparation de l'écran de confirmation : non raccordée aux écrans actuels.
 * Chaque appel doit être exécuté dans une transaction SQLite exclusive ; tout
 * échec de confirmation doit entraîner l'annulation de cette transaction. */
import {canonicalJson,type CreditNoteCommand} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import type {Kind,Note} from './credit-note-offline-prototype';
import {readPrototypeCreditBalance,prepareBalancedLocalCredit} from './credit-note-balance-storage-prototype';
import {tunisDay} from './journal';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
type Choice=CreditNoteCommand['choice'];
export type CreditReview={identity:DeviceIdentity;clientId:string;kind:Kind;invoiceId:string;expectedVersion:number;choice:Choice;day:string;source:unknown;beforeBalance:number;afterBalance:number;refund:number;retainedCredit:number;balanceDelta:number};
function day(iso:string){const date=new Date(iso);if(!Number.isFinite(date.getTime())||date.toISOString()!==iso)throw Error('Date de confirmation invalide.');return tunisDay(date);}
function review(identity:DeviceIdentity,clientId:string,note:Note,beforeBalance:number,afterBalance:number):CreditReview {
 return {identity:{...identity},clientId,kind:note.kind,invoiceId:note.command.invoiceId,expectedVersion:note.command.expectedVersion,choice:note.command.choice,day:day(note.command.recordedAt),source:note.source,beforeBalance,afterBalance,refund:note.refund,retainedCredit:note.retainedCredit,balanceDelta:note.balanceDelta};
}
/** Calcule exactement les mêmes règles que la création, mais annule toujours
 * la sauvegarde provisoire. Un aperçu ne crée donc ni avoir, ni mouvement. */
export async function previewLocalCredit(tx:Tx,identity:DeviceIdentity,clientId:string,kind:Kind,command:CreditNoteCommand,digest:(data:string)=>Promise<string>):Promise<CreditReview> {
 await tx.runAsync('SAVEPOINT credit_review_preview');
 try {
  const before=await readPrototypeCreditBalance(tx,identity,clientId,digest);
  if(before.conflict)throw Error('Solde en conflit : avoir refusé.');
  const created=await prepareBalancedLocalCredit(tx,identity,clientId,kind,command,digest);
  return review(identity,clientId,created.note,before.balance,created.balance);
 } finally {
  await tx.runAsync('ROLLBACK TO SAVEPOINT credit_review_preview');
  await tx.runAsync('RELEASE SAVEPOINT credit_review_preview');
 }
}
/** Réexécute toutes les règles et compare à ce que l'utilisateur a vu. Si la
 * facture, le solde, le choix ou le jour ont changé, rien ne doit être créé. */
export async function confirmLocalCreditReview(tx:Tx,identity:DeviceIdentity,preview:CreditReview,command:CreditNoteCommand,digest:(data:string)=>Promise<string>) {
 if(!preview||preview.identity?.commercialId!==identity.commercialId||preview.identity?.serverOrigin!==identity.serverOrigin||preview.invoiceId!==command.invoiceId||preview.expectedVersion!==command.expectedVersion||preview.choice!==command.choice||preview.day!==day(command.recordedAt))throw Error('Aperçu périmé : vérifiez à nouveau l’avoir.');
 const before=await readPrototypeCreditBalance(tx,identity,preview.clientId,digest);
 if(before.conflict)throw Error('Solde en conflit : avoir refusé.');
 const result=await prepareBalancedLocalCredit(tx,identity,preview.clientId,preview.kind,command,digest);
 if(canonicalJson(review(identity,preview.clientId,result.note,before.balance,result.balance))!==canonicalJson(preview))throw Error('Facture ou solde modifié : vérifiez à nouveau l’avoir.');
 return result;
}
