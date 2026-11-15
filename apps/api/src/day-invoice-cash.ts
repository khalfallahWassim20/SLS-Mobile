/** Capture v6 expérimentale ; la garde des clôtures existantes reste active. */
import type {PoolClient} from 'pg';
import {readDayInvoiceJournalPayments} from './day-invoice-journal.js';
export async function readServerDayInvoiceCash(db:PoolClient,commercialId:string,day:string){
 return (await readDayInvoiceJournalPayments(db,commercialId,day)).payments.map(item=>item.payment);
}
