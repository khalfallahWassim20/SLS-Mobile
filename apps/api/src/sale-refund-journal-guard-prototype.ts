import type {PoolClient} from 'pg';
import {JournalConflict} from './journal-store.js';

/** Barrière de clôture provisoire pour les remboursements entre jours ou
 * commerciaux. Le journal serveur et le journal mobile présentent désormais
 * les paiements initiaux et les sorties séparément, mais leur concordance n'est
 * pas encore attestée au moment de la clôture (plusieurs téléphones peuvent
 * partager une identité et les autres mouvements restent à rapprocher).
 * Ne pas déduire de cette garde que les journaux actuels utilisent les anciens
 * paiements nets. À appeler sous le verrou de la journée et dans la même
 * transaction que la transition. */
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
