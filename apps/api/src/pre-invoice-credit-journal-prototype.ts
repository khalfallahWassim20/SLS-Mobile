/** Garde expérimentale réservée aux tests : non branchée aux routes actives.
 * L'appel se fait sous les verrous UUID global, journée et facture du journal. */
import type {Pool,PoolClient} from 'pg';
import type {JournalSnapshot} from './journal-protocol.js';
import {JournalConflict,storeJournalSnapshot} from './journal-store.js';

async function guard(db:PoolClient,event:JournalSnapshot):Promise<void> {
 const collision=await db.query(`SELECT 1 FROM pre_invoice_credit_prototype_events WHERE operation_id=$1
  UNION ALL SELECT 1 FROM credit_note_prototype_events WHERE operation_id=$1`,[event.operationId]);
 if(collision.rows.length)throw new JournalConflict('Identifiant d’opération déjà utilisé par un avoir.');
 const cancelled=await db.query('SELECT 1 FROM pre_invoice_credit_prototype_events WHERE invoice_id=$1',[event.invoice.id]);
 if(cancelled.rows.length)throw new JournalConflict('Facture annulée : nouveau paiement refusé.');
}
export function storePrototypeGuardedJournal(pool:Pool,input:unknown,session:{token:string;secret:string}) {
 return storeJournalSnapshot(pool,input,'identified',{...session,enforceMode:true},guard);
}
