import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {readIdentifiedReference} from './identified-reference.js';

export class TourActivationConflict extends Error {}
/** Bascule unique et irréversible, réservée au service administrateur.
 * La confirmation est une procédure humaine : le serveur ne peut pas voir les appareils hors ligne. */
export async function activateIdentifiedTours(pool:Pool,admin:string,confirmation:string) {
 if(confirmation!=='TOUS LES APPAREILS SONT SYNCHRONISÉS')throw new TourActivationConflict('Confirmez que tous les appareils ont été mis à jour et synchronisés.');
 if(!admin.trim())throw new TourActivationConflict('Administrateur requis.');
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  const row=await db.query('SELECT mode FROM tour_sync_mode WHERE id=1 FOR UPDATE');
  if(row.rows[0]?.mode==='identified'){await db.query('COMMIT');return {mode:'identified' as const,status:'already-active' as const};}
  if(row.rows[0]?.mode!=='legacy')throw new TourActivationConflict('État de synchronisation inconnu.');
  const users=await db.query(`SELECT count(*)::int AS count,count(*) FILTER (WHERE cc.commercial_id IS NULL)::int AS missing
   FROM commercials c LEFT JOIN commercial_credentials cc ON cc.commercial_id=c.id WHERE c.active AND c.deleted_at IS NULL`);
  if(!users.rows[0]?.count || users.rows[0].missing)throw new TourActivationConflict('Chaque commercial actif doit avoir des identifiants avant la bascule.');
  // Les écritures partagées attendent le verrou exclusif. Une seconde connexion lit
  // l'instantané sans verrou, pour refuser les recouvrements avant le changement.
  await readIdentifiedReference(pool,true);
  await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  await db.query(`INSERT INTO audit_log(id,actor,action,entity,entity_id,entity_name,changed_fields) VALUES($1,$2,'activation','synchronisation',$3,'Mode individuel',$4)`,[randomUUID(),admin,randomUUID(),['mode']]);
  await db.query('COMMIT');return {mode:'identified' as const,status:'activated' as const};
 } catch(error){await db.query('ROLLBACK');throw error;} finally {db.release();}
}
