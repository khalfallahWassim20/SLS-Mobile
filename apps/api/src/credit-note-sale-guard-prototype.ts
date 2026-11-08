/** Réservé aux tests : ne protège pas les routes actives de l'application. */
import type {Pool,PoolClient} from 'pg';
import {storeIdentifiedSale} from './identified-operations.js';
import {JournalConflict} from './journal-store.js';

/** Appelée uniquement sous le verrou UUID et le verrou de vente, et après la
 * reconnaissance d'un renvoi identique déjà reçu. */
async function guard(db:PoolClient,event:{operationId:string;saleId:string}):Promise<void>{
 const collision=await db.query('SELECT 1 FROM credit_note_prototype_operation_ids WHERE operation_id=$1',[event.operationId]);
 if(collision.rows.length)throw new JournalConflict('Identifiant d’opération déjà utilisé par un avoir.');
 const note=await db.query('SELECT 1 FROM credit_note_prototype_events WHERE invoice_id=$1',[event.saleId]);
 if(note.rows.length)throw new JournalConflict('Facture annulée : modification refusée.');
}
export function storePrototypeGuardedSale(pool:Pool,input:unknown,session:{token:string;secret:string}){
 return storeIdentifiedSale(pool,input,{...session,enforceMode:true},guard);
}
