/** Test helper: simulate a telephone containing exactly the received events.
 * Real mobile code builds this hash from its own SQLite snapshot instead. */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {cashClosureCanonical} from '../src/index.js';
import {readSaleCashPreview} from '../../../apps/api/src/sale-cash-preview-prototype.js';
import {readJournalCashReconciliation} from '../../../apps/api/src/journal-cash-reconciliation-prototype.js';
export async function matchingCashProof(pool:Pool,commercialId:string,day:string){
 const db=await pool.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const sale=await readSaleCashPreview(db,commercialId,day);if(!sale.available)throw Error(sale.reason);
 const sales={version:5 as const,commercialId,day,initialEvents:sale.initialEvents,refundEvents:sale.refundEvents.map(({operationId,saleId,clientId,recordedAt,refund})=>({operationId,saleId,clientId,recordedAt,refund})),saleStates:sale.entries.filter(e=>sale.initialEvents.some(p=>p.saleId===e.saleId)).map(({saleId,clientId,version,total,paid})=>({saleId,clientId,version,total,paid}))};
 const journal=await readJournalCashReconciliation(db,commercialId,day);const hash=createHash('sha256').update(cashClosureCanonical(sales,journal,commercialId,day)).digest('hex');await db.query('COMMIT');return hash;
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
