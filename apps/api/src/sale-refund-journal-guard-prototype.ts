import type {PoolClient} from 'pg';
import {JournalConflict} from './journal-store.js';

/** Les ventes sont actuellement projetées à leur dernière version dans la
 * journée du créateur. Un remboursement ultérieur ne peut donc pas être
 * interprété comme un mouvement de caisse de cette journée ou de son auteur.
 * Un remboursement du créateur le jour même est déjà inclus dans le paiement
 * net de la vente : ne pas le retrancher une seconde fois. Les autres cas
 * restent bloqués plutôt que de publier des totaux trompeurs.
 * À appeler dans le même instantané que la lecture du journal. */
export async function assertSaleRefundJournalSafe(db:PoolClient,commercialId:string,day:string):Promise<void> {
 const result=await db.query(`SELECT 1 FROM identified_sale_events revision
  JOIN identified_sale_events origin ON origin.sale_id=revision.sale_id AND origin.version=1
  WHERE revision.version>1 AND (revision.payload->>'refund')::numeric>0
   AND (revision.commercial_id<>origin.commercial_id OR revision.event_date IS DISTINCT FROM origin.journal_date)
   AND ((origin.commercial_id=$1 AND origin.journal_date=$2::date)
     OR (revision.commercial_id=$1 AND (revision.event_date=$2::date OR revision.event_date IS NULL)))
  LIMIT 1`,[commercialId,day]);
 if(result.rows.length)throw new JournalConflict('Journal indisponible : un remboursement de vente doit être rapproché entre journées et commerciaux. Les exports précédents peuvent être périmés.');
}
