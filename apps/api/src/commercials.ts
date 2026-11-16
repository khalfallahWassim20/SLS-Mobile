/** Référentiel et identifiants de démonstration. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import type { Pool } from 'pg';
/** canViewPurchasePrice est facultatif : absent, il laisse le droit actuel inchangé (refusé à la création). */
export const commercialInputSchema=z.object({name:z.string().trim().min(1).max(200),active:z.boolean(),canViewPurchasePrice:z.boolean().optional()}).strict();
export type CommercialInput=z.infer<typeof commercialInputSchema>;
export async function listCommercials(pool:Pool) {
 const r=await pool.query('SELECT c.id,c.name,c.active,c.can_view_purchase_price AS "canViewPurchasePrice",cc.login FROM commercials c LEFT JOIN commercial_credentials cc ON cc.commercial_id=c.id WHERE c.deleted_at IS NULL ORDER BY c.name,c.id LIMIT 10000');
 return r.rows;
}
/** Seul le serveur décide : un commercial inactif, supprimé ou sans droit explicite ne voit jamais les prix d'achat. */
export async function commercialCanViewPurchasePrice(pool:Pool,commercialId:string):Promise<boolean> {
 const r=await pool.query('SELECT can_view_purchase_price AS allowed FROM commercials WHERE id=$1 AND active AND deleted_at IS NULL',[z.string().uuid().parse(commercialId)]);
 return r.rows[0]?.allowed===true;
}
/** Écriture et piste d'audit dans une seule transaction. L'acteur vient de la session admin serveur. */
export async function saveCommercial(pool:Pool, actor:string, input:unknown, existingId?:string) {
 const data=commercialInputSchema.parse(input);
 if(!actor || !actor.trim()) throw new RangeError('Administrateur requis.');
 const id=existingId ? z.string().uuid().parse(existingId) : randomUUID();
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  const old=existingId ? await db.query('SELECT id,name,active,can_view_purchase_price AS "canViewPurchasePrice" FROM commercials WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id]) : null;
  if (existingId && !old?.rows.length) {await db.query('ROLLBACK');return null;}
  const result=existingId
   ? await db.query('UPDATE commercials SET name=$2,active=$3,can_view_purchase_price=COALESCE($4::boolean,can_view_purchase_price),updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id,name,active,can_view_purchase_price AS "canViewPurchasePrice"',[id,data.name,data.active,data.canViewPurchasePrice ?? null])
   : await db.query('INSERT INTO commercials(id,name,active,can_view_purchase_price) VALUES($1,$2,$3,COALESCE($4::boolean,false)) RETURNING id,name,active,can_view_purchase_price AS "canViewPurchasePrice"',[id,data.name,data.active,data.canViewPurchasePrice ?? null]);
  const saved=result.rows[0];
  const accessChanged=old ? old.rows[0].canViewPurchasePrice !== saved.canViewPurchasePrice : false;
  // Une désactivation, une réactivation ou un changement du droit aux prix d'achat révoque les sessions précédentes :
  // l'appareil doit se reconnecter et retélécharger une référence conforme au nouveau droit.
  if (old && (old.rows[0].active !== saved.active || accessChanged)) await db.query('UPDATE commercial_credentials SET session_version=session_version+1 WHERE commercial_id=$1',[id]);
  const changed=old ? [...['name','active'].filter(key=>old.rows[0][key]!==saved[key]),...(accessChanged?['canViewPurchasePrice']:[])] : (saved.canViewPurchasePrice?['canViewPurchasePrice']:[]);
  await db.query('INSERT INTO audit_log(id,actor,action,entity,entity_id,entity_name,changed_fields) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),actor,existingId?'modification':'création','commercials',id,saved.name,changed]);
  await db.query('COMMIT'); return {id:saved.id,name:saved.name,active:saved.active};
 } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}

// Identifiant ASCII normalisé pour éviter les ambiguïtés ; bcrypt limite les mots de passe à 72 octets.
export const credentialsSchema=z.object({
 login:z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,50}$/),
 password:z.string().min(12).refine(value=>Buffer.byteLength(value,'utf8')<=72)
}).strict();
export async function setCommercialCredentials(pool:Pool, actor:string, id:string, input:unknown) {
 const commercialId=z.string().uuid().parse(id), data=credentialsSchema.parse(input);
 if (!actor.trim()) throw new RangeError('Administrateur requis.');
 const hash=await bcrypt.hash(data.password,12);
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  const commercial=await db.query('SELECT name FROM commercials WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[commercialId]);
  if (!commercial.rows.length) {await db.query('ROLLBACK');return null;}
  await db.query(`INSERT INTO commercial_credentials(commercial_id,login,password_hash) VALUES($1,$2,$3)
    ON CONFLICT(commercial_id) DO UPDATE SET login=excluded.login,password_hash=excluded.password_hash,session_version=commercial_credentials.session_version+1,updated_at=now()`,[commercialId,data.login,hash]);
  await db.query('INSERT INTO audit_log(id,actor,action,entity,entity_id,entity_name,changed_fields) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),actor,'identifiants modifiés','commercials',commercialId,commercial.rows[0].name,['login','password']]);
  await db.query('COMMIT');return {login:data.login};
 } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
