import {calculateFullCancellation,type FullCreditChoice} from './credit-note.ts';

/** Prototype de règles pures : le serveur doit authentifier l'acteur, verrouiller
 * la vente, le ou les jours et l'identifiant d'opération, et persister le résultat
 * atomiquement. Rien dans ce module ne réalise ces protections à lui seul. */
export type CreditNoteActor={id:string;role:'admin'|'commercial'};
export type CreditNoteCommand={operationId:string;invoiceId:string;expectedVersion:number;recordedAt:string;choice:FullCreditChoice|null};
export type CreditNoteSource={invoiceId:string;version:number;total:number;netPaid:number;cancelled:boolean};
export type CreditNoteEvent={command:CreditNoteCommand;actor:CreditNoteActor;source:CreditNoteSource;noteTotal:number;refund:number;retainedCredit:number;balanceDelta:number;resultVersion:number};
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
function exactTimestamp(x:unknown):x is string {
 if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x))return false;
 const n=Date.parse(x);return Number.isFinite(n)&&new Date(n).toISOString()===x;
}
function validate(actor:CreditNoteActor,command:CreditNoteCommand) {
 if(!actor || !['admin','commercial'].includes(actor.role) || typeof actor.id!=='string' || !actor.id.trim() || actor.id.length>200 || (actor.role==='commercial'&&!uuid(actor.id))) throw new RangeError('Acteur invalide');
 if(!command || !uuid(command.operationId)||!uuid(command.invoiceId) || !Number.isSafeInteger(command.expectedVersion)||command.expectedVersion<1||command.expectedVersion>=1000000 || !exactTimestamp(command.recordedAt) || ![null,'refund','credit'].includes(command.choice)) throw new RangeError('Demande d’avoir invalide');
}
function matches(event:CreditNoteEvent,actor:CreditNoteActor,c:CreditNoteCommand):boolean {
 const old=event.command;
 return event.actor.id===actor.id&&event.actor.role===actor.role&&old.operationId===c.operationId&&old.invoiceId===c.invoiceId&&old.expectedVersion===c.expectedVersion&&old.recordedAt===c.recordedAt&&old.choice===c.choice;
}
/** `previous` vient exclusivement d'un registre fiable consulté sous verrou UUID ;
 * le renvoi identique retourne l'accusé initial même si la journée est maintenant fermée.
 * Les clôtures et la version doivent être relues dans la transaction d'écriture. */
export function prepareFullCreditNote(input:{actor:CreditNoteActor;command:CreditNoteCommand;source:CreditNoteSource;daysOpen:boolean;previous:CreditNoteEvent|null}):{status:'received'|'duplicate';event:CreditNoteEvent} {
 const {actor,command,source,daysOpen,previous}=input;
 validate(actor,command);
 if(previous){
  if(!matches(previous,actor,command))throw new RangeError('Identifiant d’opération déjà utilisé avec un autre contenu ou acteur');
  return {status:'duplicate',event:previous};
 }
 if(daysOpen!==true)throw new RangeError('Journée clôturée ou état inconnu');
 if(!source||source.invoiceId!==command.invoiceId||source.version!==command.expectedVersion)throw new RangeError('Version de facture périmée ou incohérente');
 const result=calculateFullCancellation({balance:0,invoiceTotal:source.total,invoiceNetPaid:source.netPaid,alreadyCancelled:source.cancelled,choice:command.choice??undefined});
 const event:CreditNoteEvent={command:{...command},actor:{...actor},source:{...source},noteTotal:result.creditNoteTotal,refund:result.refund,retainedCredit:result.retainedCredit,balanceDelta:result.balanceAfter,resultVersion:source.version+1};
 return {status:'received',event};
}
