/** Barrière mobile v3 et vérifications atomiques préparatoires v5. L'appelant
 * doit conserver la transaction SQLite exclusive jusqu'à l'écriture. */
import {balanceAfterSettlement,isSaleBlocked,summarizePreInvoice,validatePreInvoiceReceipt} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import {readPrototypeCreditReferenceCache} from './credit-note-reference-cache-prototype';
import {readPrototypeCreditBalance} from './credit-note-balance-storage-prototype';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
export type CreditWriteContext={identity:DeviceIdentity;expectedBalance:number};
type Intent={kind:'sale'|'preinvoice'|'edit'|'settlement'|'receipt';clientId:string;amount?:number;day?:string};
/** Les écrans anciens ignorent les avoirs : dès qu'un avoir local ou distant
 * est connu, ils ne doivent pas créer de nouvelles écritures ni clôturer.
 * Une liaison v5 interdit aussi les écritures v3 avant le premier avoir :
 * leurs calculs ne vérifient pas atomiquement le solde v5. */
export async function assertLegacyMobileCreditSafe(tx:Tx,identity:DeviceIdentity|null) {
 const row=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM offline_credit_prototype) AS n');
 if(!row||row.n)throw Error('Des avoirs existent : mise à jour des écrans et synchronisation v5 nécessaires.');
 if(!identity)return;
 const ref=await readPrototypeCreditReferenceCache(tx,identity);
 if(ref&&(ref.saleStates.some(s=>s.creditNote)||ref.journalStates.some(j=>j.creditNote)))throw Error('Des avoirs existent : mise à jour des écrans et synchronisation v5 nécessaires.');
 if(ref)throw Error('Téléphone lié en v5 : utilisez les écrans et calculs compatibles avant toute écriture.');
}
/** Vérifie à nouveau l'identité liée, l'état client et le solde montrés avant
 * l'opération. Le plafond porte sur le solde connu ; hors ligne il peut être
 * périmé sur d'autres appareils. Zéro signifie aucune limite. */
export async function assertCreditWritePrototype(tx:Tx,context:CreditWriteContext,intent:Intent,digest:(text:string)=>Promise<string>) {
 if(!context||!Number.isSafeInteger(context.expectedBalance)||!intent||typeof intent.clientId!=='string')throw Error('Contexte de vente invalide.');
 const ref=await readPrototypeCreditReferenceCache(tx,context.identity),client=ref?.clients.find(c=>c.id===intent.clientId);
 if(!ref||!client)throw Error('Client ou référence v5 indisponible.');
 const actual=await readPrototypeCreditBalance(tx,context.identity,intent.clientId,digest);
 if(actual.conflict)throw Error('Solde en conflit : rapprochement nécessaire.');
 if(actual.balance!==context.expectedBalance)throw Error('Solde modifié : vérifiez à nouveau avant de continuer.');
 if((intent.kind==='sale'||intent.kind==='preinvoice')&&!client.active)throw Error('Client désactivé : nouvelle vente ou facture refusée.');
 if(intent.kind==='sale'&&isSaleBlocked(actual.balance,Number(client.creditLimit),false))throw Error('Limite de crédit atteinte : vente bloquée.');
 if(intent.kind==='preinvoice'){
  const parsed=new Date(`${intent.day}T00:00:00.000Z`);if(typeof intent.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(intent.day)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==intent.day)throw Error('Date de facture invalide.');
  if(ref.journalStates.some(j=>j.clientId===intent.clientId&&j.journalDate===intent.day))throw Error('Une facture préétablie existe déjà sur le serveur pour ce client et ce jour.');
 }
 if(intent.kind==='settlement')balanceAfterSettlement(actual.balance,intent.amount!);
 return actual;
}
/** Le plafond de dette ancienne ne dépend pas du paiement de la préétablie.
 * Ces données doivent être lues dans la même transaction que l'écriture. */
export function assertCreditReceiptPrototype(balance:number,invoiceTotal:number,previous:Parameters<typeof summarizePreInvoice>[1],value:{prePaid:number;oldDebtPaid:number;creditFull:boolean;oldDebtLimitAtStart:number}) {
 const before=summarizePreInvoice(invoiceTotal,previous),preDebt=before.declared?before.remaining:0,availableNow=Math.max(0,balance-preDebt);
 const first=previous[0] as (typeof previous[number]&{oldDebtLimitAtStart?:number})|undefined,limit=first?first.oldDebtLimitAtStart:availableNow;
 if(typeof limit!=='number'||!Number.isSafeInteger(limit)||limit<0||value.oldDebtLimitAtStart!==limit)throw Error('Ancienne dette modifiée : vérifiez à nouveau.');
 const available=Math.min(availableNow,Math.max(0,limit-before.oldDebtPaid));
 validatePreInvoiceReceipt(invoiceTotal,previous,value,available);return available;
}
