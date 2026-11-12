/** Préparation des saisies du journal v5. La sauvegarde revérifie le tout
 * atomiquement avec le solde et les versions dans SQLite. */
import {parseDinars,summarizePreInvoice} from '@sls/domain';
import {assertCreditReceiptPrototype,type CreditWriteContext} from './credit-note-write-guard-prototype';
import {tunisDay} from './journal';
import type {TourPreInvoice,TourJournalReceipt} from './storage';
import type {CreditFormClient} from './credit-sale-settlement-prototype';
type ReceiptInput={prePaid:string;oldDebtPaid:string;creditFull:boolean;mode:'Espèces'|'Chèque'|'Virement';chequeNumber:string;chequeBank:string;chequeDue:string};
function checked(client:CreditFormClient,context:CreditWriteContext,day:string,createdAt:string){
 if(!client||!context||client.conflict||client.balance===null||!Number.isSafeInteger(client.balance)||client.balance!==context.expectedBalance)throw Error('Solde modifié ou en conflit : actualisez.');
 const d=new Date(createdAt);if(!Number.isFinite(d.getTime())||d.toISOString()!==createdAt||tunisDay(d)!==day)throw Error('La date de tournée a changé : actualisez.');
}
export function prepareCreditPreInvoice(client:CreditFormClient,context:CreditWriteContext,day:string,amount:string,createdAt:string):Omit<TourPreInvoice,'id'>{
 checked(client,context,day,createdAt);if(!client.active)throw Error('Client désactivé : facture refusée.');
 const value=parseDinars(amount);if(value<=0)throw Error('Le montant préétabli doit être positif.');
 return {journalDate:day,clientId:client.id,clientName:client.name,sector:client.sector,amount:value,createdAt};
}
export function prepareCreditJournalReceipt(client:CreditFormClient,context:CreditWriteContext,invoice:TourPreInvoice,previous:TourJournalReceipt[],input:ReceiptInput,createdAt:string):{value:Omit<TourJournalReceipt,'id'>;availableOldDebt:number}{
 checked(client,context,invoice.journalDate,createdAt);
 if(invoice.clientId!==client.id||previous.some(r=>r.preInvoiceId!==invoice.id||r.clientId!==client.id||r.journalDate!==invoice.journalDate))throw Error('Facture ou historique incohérent.');
 if(!['Espèces','Chèque','Virement'].includes(input.mode))throw Error('Mode de paiement invalide.');
 const prePaid=input.prePaid.trim()?parseDinars(input.prePaid):0,oldDebtPaid=input.oldDebtPaid.trim()?parseDinars(input.oldDebtPaid):0;
 const before=summarizePreInvoice(invoice.amount,previous),availableNow=Math.max(0,client.balance!-(before.declared?before.remaining:0));
 const oldDebtLimitAtStart=previous.length?previous[0].oldDebtLimitAtStart:availableNow;
 const chequeNumber=input.mode==='Chèque'?input.chequeNumber.trim():'',chequeBank=input.mode==='Chèque'?input.chequeBank.trim():'',chequeDue=input.mode==='Chèque'?input.chequeDue.trim():'';
 if([chequeNumber,chequeBank,chequeDue].some(x=>x.length>100))throw Error('Détails du chèque trop longs.');
 if(input.mode==='Chèque'&&(prePaid||oldDebtPaid)&&(!chequeNumber||!chequeBank||!chequeDue))throw Error('Renseignez le numéro, la banque et l’échéance du chèque.');
 const value={preInvoiceId:invoice.id,clientId:client.id,journalDate:invoice.journalDate,createdAt,prePaid,oldDebtPaid,creditFull:input.creditFull,mode:input.mode,chequeNumber,chequeBank,chequeDue,oldDebtLimitAtStart};
 const availableOldDebt=assertCreditReceiptPrototype(client.balance!,invoice.amount,previous,value);
 return {value,availableOldDebt};
}
