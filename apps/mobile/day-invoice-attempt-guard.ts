import {readSaleEditAttempt} from './day-invoice-sale-edit-attempt';
/** Empêche une clôture ou une synchronisation de passer devant une décision
 * de vente ou de règlement durable encore ouverte. Les reçus déjà enregistrés
 * sont vérifiés puis traités normalement par les files et preuves de caisse. */
import {readDaySaleAttempt} from './day-invoice-sale-attempt';
import {readDayPaymentAttempt} from './day-invoice-payment-attempt';
import {canonicalJson} from '@sls/domain';
import type {NewDayPreinvoice} from './day-invoice-preinvoice-create';
import {readPreinvoiceAttempt} from './day-invoice-preinvoice-attempt';
import {readOldDebtAttempt} from './day-invoice-old-debt-attempt';
import {tunisDay} from './journal';
import type {DeviceIdentity} from './identified-device';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
/** Sans day : toute décision inachevée bloque la synchronisation. Avec day :
 * seules la journée de facture ou celle du mouvement bloquent la clôture. */
export async function assertDayInvoiceAttemptsSettled(tx:Tx,identity:DeviceIdentity,day?:string,ignorePreinvoiceAttempt?:NewDayPreinvoice,ignoreSaleEditOperationId?:string){
 const tables=await tx.getFirstAsync<{sale:number;payment:number;debt:number;preinvoice:number}>(`SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_sale_attempt') AS sale, EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_payment_attempt') AS payment, EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_old_debt_attempt') AS debt, EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_preinvoice_attempt') AS preinvoice`);
 const editTable=await tx.getFirstAsync<{n:number}>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_sale_edit_attempt') AS n");
 if(!editTable||![0,1].includes(editTable.n))throw Error('État de modification indisponible.');
 if(editTable.n){const edit=await readSaleEditAttempt(tx,identity);if(edit&&!edit.result&&edit.attempt.operationId!==ignoreSaleEditOperationId&&(!day||edit.attempt.day===day||tunisDay(new Date(edit.attempt.recordedAt))===day))throw Error('Modification en attente de confirmation : reprenez ou abandonnez la tentative.');}
 if(!tables||![0,1].includes(tables.sale)||![0,1].includes(tables.payment)||![0,1].includes(tables.debt)||![0,1].includes(tables.preinvoice))throw Error('État des tentatives indisponible.');
 const sale=tables.sale?await readDaySaleAttempt(tx,identity):null,payment=tables.payment?await readDayPaymentAttempt(tx,identity):null;
 const preinvoice=tables.preinvoice?await readPreinvoiceAttempt(tx,identity):null;
 if(preinvoice&&!preinvoice.result&&(!ignorePreinvoiceAttempt||canonicalJson(preinvoice.attempt)!==canonicalJson(ignorePreinvoiceAttempt))&&(!day||preinvoice.attempt.day===day))throw Error('Préétablie en attente de confirmation : reprenez ou abandonnez la tentative.');
 const debt=tables.debt?await readOldDebtAttempt(tx,identity):null;
 if(debt&&!debt.result&&(!day||debt.attempt.event.invoiceDay===day||tunisDay(new Date(debt.attempt.event.event.settlement.createdAt))===day))throw Error('Ancienne dette en attente de confirmation : reprenez ou abandonnez la tentative.');
 if(sale&&!sale.result&&(!day||sale.attempt.day===day))throw Error('Vente en attente de confirmation : reprenez ou abandonnez la tentative.');
 if(payment&&!payment.result&&(!day||payment.attempt.day===day||tunisDay(new Date(payment.attempt.recordedAt))===day))throw Error('Règlement en attente de confirmation : reprenez ou abandonnez la tentative.');
}

/** Une seule intention ou reçu non acquitté à la fois, quelle que soit la
 * journée. À appeler sous transaction exclusive avant préparation et avant
 * confirmation. Les reçus restent autorisés pour la synchronisation mais pas
 * pour une nouvelle saisie qui pourrait invalider leur preuve. */
export async function assertDayInvoiceAttemptExclusive(tx:Tx,identity:DeviceIdentity,ignore?:{kind:'preinvoice'|'sale'|'saleEdit'|'payment'|'oldDebt';operationId:string}){
 const tables=await tx.getFirstAsync<{sale:number;payment:number;debt:number;preinvoice:number;edit:number}>(`SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_sale_attempt') AS sale, EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_payment_attempt') AS payment, EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_old_debt_attempt') AS debt, EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_preinvoice_attempt') AS preinvoice, EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_sale_edit_attempt') AS edit`);
 if(!tables||![tables.sale,tables.payment,tables.debt,tables.preinvoice,tables.edit].every(n=>n===0||n===1))throw Error('État des tentatives indisponible.');
 const check=(kind:NonNullable<typeof ignore>['kind'],id:string)=>{if(!ignore||ignore.kind!==kind||ignore.operationId!==id)throw Error('Une autre opération attend confirmation ou vérification : reprenez-la avant de continuer.');};
 if(tables.preinvoice){const x=await readPreinvoiceAttempt(tx,identity);if(x)check('preinvoice',x.attempt.operationId);}
 if(tables.sale){const x=await readDaySaleAttempt(tx,identity);if(x)check('sale',x.attempt.operationId);}
 if(tables.edit){const x=await readSaleEditAttempt(tx,identity);if(x)check('saleEdit',x.attempt.operationId);}
 if(tables.payment){const x=await readDayPaymentAttempt(tx,identity);if(x)check('payment',x.attempt.operationId);}
 if(tables.debt){const x=await readOldDebtAttempt(tx,identity);if(x)check('oldDebt',x.attempt.event.event.operationId);}
}
