import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';

/** Usage exclusif en maintenance, avec API arrêtée et tous les téléphones déconnectés.
 * Ne supprime ni les fiches, ni les comptes, ni l'audit, ni les soldes initiaux. */
export async function resetTestOperations(pool:Pool):Promise<void> {
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout = '5s'");
  // Verrou exclusif aussi utilisé par la bascule ; ne remplace pas l'arrêt de l'API.
  await db.query('SELECT mode FROM tour_sync_mode WHERE id=1 FOR UPDATE');
  const creditNames=['credit_refund_assignment_prototype','credit_note_prototype_movements','credit_note_prototype_events','pre_invoice_credit_prototype_movements','pre_invoice_credit_prototype_events','credit_note_abandon_prototype','credit_note_prototype_operation_ids'];
  const creditTables=await db.query('SELECT to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS name',[creditNames]);
  const present=creditTables.rows.map(r=>r.present);
  if(present.length!==creditNames.length||present.some(v=>typeof v!=='boolean')||(present.some(Boolean)&&!present.every(Boolean)))throw Error('Migration des avoirs incomplète : nettoyage refusé.');
  if(present.every(Boolean))for(const table of creditNames)await db.query(`DELETE FROM ${table}`);
  const remote=await db.query("SELECT to_regclass('remote_sale_abandon_prototype') IS NOT NULL AS present");
  if(typeof remote.rows[0]?.present!=='boolean')throw Error('État des révisions indisponible.');
  if(remote.rows[0].present)await db.query('DELETE FROM remote_sale_abandon_prototype');
  for(const table of [
   'tour_closure_requests','tour_closure_events','tour_closures',
   'identified_journal_events','identified_journal_receipt_ids','identified_journal_invoices',
   'sync_journal_events','sync_journal_receipt_ids','sync_journal_invoices',
   'demo_journal_events','demo_journal_receipt_ids','demo_journal_invoices',
   'identified_sale_events','identified_settlements','demo_sale_events','demo_settlements'
  ]) await db.query(`DELETE FROM ${table}`);
  await db.query(`INSERT INTO audit_log(id,actor,action,entity,entity_id,entity_name,changed_fields)
   VALUES($1,'maintenance locale','nettoyage','opérations fictives',$2,'Historique des opérations','{}')`,[randomUUID(),randomUUID()]);
  await db.query('COMMIT');
 } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
