/** Construction de l'intention de règlement de la facture totale, sans
 * ventilation. La transaction revalide les sources avant toute écriture. */
import {parseDinars} from '@sls/domain';
import type {captureDayInvoiceForm} from './day-invoice-form';
import type {PaymentAttempt} from './day-invoice-payment-attempt';
import type {DayInvoicePayment} from '../../packages/domain/src/day-invoice';
type Form=Awaited<ReturnType<typeof captureDayInvoiceForm>>;
type Draft={amount:string;mode:DayInvoicePayment['mode'];chequeNumber:string;chequeBank:string;chequeDue:string};
export function makeDayPaymentAttempt(form:Form,clientId:string,day:string,draft:Draft,operationId:string,recordedAt:string):PaymentAttempt{
 if(!form||form.view.clientId!==clientId||form.view.day!==day||!form.fingerprint||!Number.isSafeInteger(form.view.remaining)||form.view.remaining<=0)throw Error('Facture ou journée indisponible : vérifiez à nouveau.');
 if(!draft||!['Espèces','Chèque','Virement','Crédit'].includes(draft.mode)||typeof draft.amount!=='string'||typeof draft.chequeNumber!=='string'||typeof draft.chequeBank!=='string'||typeof draft.chequeDue!=='string')throw Error('Mode ou données du règlement invalides.');
 const eligibleCredit=!!form.source.preInvoice&&!form.view.declared&&form.view.paid===0;
 if(draft.mode==='Crédit'&&!eligibleCredit)throw Error('Crédit total réservé à une facture entièrement impayée.');
 const amount=draft.mode==='Crédit'?0:parseDinars(draft.amount);
 if(draft.mode!=='Crédit'&&(amount<=0||amount>form.view.remaining))throw Error('Le montant doit être supérieur à zéro et inférieur ou égal au reste de la facture.');
 const chequeNumber=draft.mode==='Chèque'?draft.chequeNumber.trim():'',chequeBank=draft.mode==='Chèque'?draft.chequeBank.trim():'',chequeDue=draft.mode==='Chèque'?draft.chequeDue.trim():'';
 if(draft.mode==='Chèque'&&(!chequeNumber||!chequeBank||!chequeDue||[chequeNumber,chequeBank,chequeDue].some(s=>s.length>100)))throw Error('Renseignez le numéro, la banque et l’échéance du chèque.');
 return {clientId,day,fingerprint:form.fingerprint,operationId,recordedAt,amount,mode:draft.mode,chequeNumber,chequeBank,chequeDue};
}
