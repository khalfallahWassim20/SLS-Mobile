import type {PoolClient} from 'pg';
import {JournalConflict} from './journal-store.js';
/** Appeler uniquement avec le verrou exclusif de tour_sync_mode : il sérialise
 * les clôtures v5 avec les nouveaux avoirs, y compris les autres commerciaux.
 * Une caisse encore inconnue ne peut pas modifier une journée déjà clôturée. */
export async function assertNoClosedDayForUnassignedCreditRefund(db:PoolClient,recordedAt:string):Promise<void>{
 const result=await db.query(`SELECT 1 FROM tour_closures
  WHERE journal_date=(($1::timestamptz AT TIME ZONE 'Africa/Tunis')::date) AND status='closed' LIMIT 1`,[recordedAt]);
 if(result.rows.length)throw new JournalConflict('Une journée commerciale est déjà clôturée à cette date : remboursement administrateur sans caisse attribuée refusé.');
}
