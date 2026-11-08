import type {PoolClient} from 'pg';
export class IdentifiedOverlap extends Error {}
type Kind='sale'|'settlement'|'journal';
/** Toujours verrouiller l'UUID avant les autres verrous d'opération identifiée. */
export async function lockIdentifiedOperation(db:PoolClient,id:string):Promise<void> {
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['identified-operation-global',id]);
}
/** L'ancien espace est immuable lors du mode individuel ; aucun UUID ne peut désigner deux opérations. */
export async function assertOperationUnambiguous(db:PoolClient,id:string,kind:Kind):Promise<void> {
 const r=await db.query(`SELECT EXISTS(SELECT 1 FROM demo_sale_events WHERE operation_id=$1)
 OR EXISTS(SELECT 1 FROM demo_settlements WHERE operation_id=$1)
 OR EXISTS(SELECT 1 FROM sync_journal_events WHERE operation_id=$1)
 OR ($2<>'sale' AND EXISTS(SELECT 1 FROM identified_sale_events WHERE operation_id=$1))
 OR ($2<>'settlement' AND EXISTS(SELECT 1 FROM identified_settlements WHERE operation_id=$1))
 OR ($2<>'journal' AND EXISTS(SELECT 1 FROM identified_journal_events WHERE operation_id=$1)) AS conflict`,[id,kind]);
 if(r.rows[0]?.conflict!==false)throw new IdentifiedOverlap('Identifiant d’opération déjà présent dans un autre espace : rapprochement nécessaire.');
}
