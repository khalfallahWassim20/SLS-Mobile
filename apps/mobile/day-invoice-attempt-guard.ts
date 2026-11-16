/** Empêche une clôture ou une synchronisation de passer devant une décision
 * de vente ou de règlement durable encore ouverte. Les reçus déjà enregistrés
 * sont vérifiés puis traités normalement par les files et preuves de caisse. */
import {readDaySaleAttempt} from './day-invoice-sale-attempt';
import {readDayPaymentAttempt} from './day-invoice-payment-attempt';
import {tunisDay} from './journal';
import type {DeviceIdentity} from './identified-device';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
/** Sans day : toute décision inachevée bloque la synchronisation. Avec day :
 * seules la journée de facture ou celle du mouvement bloquent la clôture. */
export async function assertDayInvoiceAttemptsSettled(tx:Tx,identity:DeviceIdentity,day?:string){
 const tables=await tx.getFirstAsync<{sale:number;payment:number}>(`SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_sale_attempt') AS sale, EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_payment_attempt') AS payment`);
 if(!tables||![0,1].includes(tables.sale)||![0,1].includes(tables.payment))throw Error('État des tentatives indisponible.');
 const sale=tables.sale?await readDaySaleAttempt(tx,identity):null,payment=tables.payment?await readDayPaymentAttempt(tx,identity):null;
 if(sale&&!sale.result&&(!day||sale.attempt.day===day))throw Error('Vente en attente de confirmation : reprenez ou abandonnez la tentative.');
 if(payment&&!payment.result&&(!day||payment.attempt.day===day||tunisDay(new Date(payment.attempt.recordedAt))===day))throw Error('Règlement en attente de confirmation : reprenez ou abandonnez la tentative.');
}
