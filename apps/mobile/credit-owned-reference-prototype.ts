/** Projection des avoirs reçus du serveur, par propriétaire de facture.
 * Une référence ancienne ne prouve pas l'absence d'avoirs. */
import {calculatePreInvoiceCancellation} from '@sls/domain';
import {tunisDay} from './journal';
import type {validatePrototypeCreditReference} from './credit-note-reference-prototype';
export type OwnedCredit={operationId:string;invoiceId:string;kind:'sale'|'preinvoice';clientId:string;clientName:string;recordedAt:string;invoiceDay:string;invoiceTotal:number;refund:number;retainedCredit:number;actorRole:'commercial'|'admin';actorId:string};
export function projectOwnedCredits(reference:ReturnType<typeof validatePrototypeCreditReference>,commercialId:string,day:string):OwnedCredit[] {
 if(reference.creditOwners===null)throw Error('Propriétaires des avoirs indisponibles : synchronisez.');
 const date=new Date(`${day}T00:00:00.000Z`);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day)throw Error('Date invalide.');
 const owners=new Map(reference.creditOwners.map(x=>[x.operationId,x.ownerId])),clients=new Map(reference.clients.map(x=>[x.id,x.name]));
 const result:OwnedCredit[]=[];
 for(const sale of reference.saleStates){
  const note=sale.creditNote;if(!note||owners.get(note.command.operationId)!==commercialId||tunisDay(new Date(note.command.recordedAt))!==day)continue;
  const clientName=clients.get(sale.clientId);if(!clientName)throw Error('Client de l’avoir introuvable.');
  // La date originale de vente n'est pas exposée dans le référentiel : elle
  // ne doit jamais être devinée à partir de la date de l’avoir.
  result.push({operationId:note.command.operationId,invoiceId:sale.saleId,kind:'sale',clientId:sale.clientId,clientName,recordedAt:note.command.recordedAt,invoiceDay:'',invoiceTotal:note.noteTotal,refund:note.refund,retainedCredit:note.retainedCredit,actorRole:note.actor.role,actorId:note.actor.id});
 }
 for(const invoice of reference.journalStates){
  const note=invoice.creditNote;if(!note||owners.get(note.operationId)!==commercialId||tunisDay(new Date(note.recordedAt))!==day)continue;
  const clientName=clients.get(invoice.clientId);if(!clientName||!invoice.journalDate)throw Error('Client ou date de l’avoir introuvable.');
  const calc=calculatePreInvoiceCancellation({balance:0,invoiceTotal:invoice.total,receipts:invoice.receipts,alreadyCancelled:false,choice:note.choice??undefined});
  result.push({operationId:note.operationId,invoiceId:invoice.id,kind:'preinvoice',clientId:invoice.clientId,clientName,recordedAt:note.recordedAt,invoiceDay:invoice.journalDate,invoiceTotal:invoice.total,refund:calc.refund,retainedCredit:calc.retainedCredit,actorRole:note.actor.role,actorId:note.actor.id});
 }
 return result.sort((a,b)=>a.operationId<b.operationId?-1:a.operationId>b.operationId?1:0);
}
