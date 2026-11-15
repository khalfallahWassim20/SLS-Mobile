/** Préparation locale d'un règlement distinct de la facture du jour. */
import {parseDinars} from '@sls/domain';
import {validateOldDebtEvent,type OldDebtEvent,type OldDebtSettlement} from './day-invoice-old-debt-queue';

export type OldDebtDraft={amount:string;mode:OldDebtSettlement['mode'];chequeNumber:string;chequeBank:string;chequeDue:string};
export function prepareOldDebtInput(form:{clientId:string;clientName:string;day:string;available:number;fingerprint:string},draft:OldDebtDraft,operationId:string,recordedAt:string):{fingerprint:string;event:OldDebtEvent}{
 const amount=parseDinars(draft.amount);
 if(!Number.isSafeInteger(form.available)||form.available<0||amount<=0||amount>form.available)throw Error('Le montant doit être supérieur à zéro et ne pas dépasser l’ancienne dette disponible.');
 const cheque=draft.mode==='Chèque';
 const settlement:OldDebtSettlement={syncOperationId:operationId,createdAt:recordedAt,clientId:form.clientId,clientName:form.clientName,amount,mode:draft.mode,chequeNumber:cheque?draft.chequeNumber.trim():'',chequeBank:cheque?draft.chequeBank.trim():'',chequeDue:cheque?draft.chequeDue.trim():''};
 const event={invoiceDay:form.day,event:{operationId,settlement}};
 validateOldDebtEvent(event);
 return {fingerprint:form.fingerprint,event};
}
