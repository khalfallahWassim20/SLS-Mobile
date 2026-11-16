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
export async function assertDayInvoiceAttemptsSettled(tx:Tx,identity:DeviceIdentity,day?:string,ignorePreinvoiceAttempt?:NewDayPreinvoice){
 const tables=await tx.getFirstAsync<{sale:number;payment:number;debt:number;preinvoice:number}>(`SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_sale_attempt') AS sale, EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_payment_attempt') AS payment, EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_old_debt_attempt') AS debt, EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_preinvoice_attempt') AS preinvoice`);
 if(!tables||![0,1].includes(tables.sale)||![0,1].includes(tables.payment)||![0,1].includes(tables.debt)||![0,1].includes(tables.preinvoice))throw Error('État des tentatives indisponible.');
 const sale=tables.sale?await readDaySaleAttempt(tx,identity):null,payment=tables.payment?await readDayPaymentAttempt(tx,identity):null;
 const preinvoice=tables.preinvoice?await readPreinvoiceAttempt(tx,identity):null;
 if(preinvoice&&!preinvoice.result&&(!ignorePreinvoiceAttempt||canonicalJson(preinvoice.attempt)!==canonicalJson(ignorePreinvoiceAttempt))&&(!day||preinvoice.attempt.day===day))throw Error('Préétablie en attente de confirmation : reprenez ou abandonnez la tentative.');
 const debt=tables.debt?await readOldDebtAttempt(tx,identity):null;
 if(debt&&!debt.result&&(!day||debt.attempt.event.invoiceDay===day||tunisDay(new Date(debt.attempt.event.event.settlement.createdAt))===day))throw Error('Ancienne dette en attente de confirmation : reprenez ou abandonnez la tentative.');
 if(sale&&!sale.result&&(!day||sale.attempt.day===day))throw Error('Vente en attente de confirmation : reprenez ou abandonnez la tentative.');
 if(payment&&!payment.result&&(!day||payment.attempt.day===day||tunisDay(new Date(payment.attempt.recordedAt))===day))throw Error('Règlement en attente de confirmation : reprenez ou abandonnez la tentative.');
}
