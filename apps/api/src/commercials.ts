/** Référentiel et identifiants de démonstration. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import type { Pool } from 'pg';
export const commercialInputSchema=z.object({name:z.string().trim().min(1).max(200),active:z.boolean()}).strict();
export type CommercialInput=z.infer<typeof commercialInputSchema>;
export async function listCommercials(pool:Pool) {
 const r=await pool.query('SELECT c.id,c.name,c.active,cc.login FROM commercials c LEFT JOIN commercial_credentials cc ON cc.commercial_id=c.id WHERE c.deleted_at IS NULL ORDER BY c.name,c.id LIMIT 10000');
 return r.rows;
}
/** Écriture et piste d'audit dans une seule transaction. L'acteur vient de la session admin serveur. */
export async function saveCommercial(pool:Pool, actor:string, input:unknown, existingId?:string) {
 const data=commercialInputSchema.parse(input);
 if(!actor || !actor.trim()) throw new RangeError('Administrateur requis.');
 const id=existingId ? z.string().uuid().parse(existingId) : randomUUID();
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  const old=existingId ? await db.query('SELECT id,name,active FROM commercials WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id]) : null;
  if (existingId && !old?.rows.length) {await db.query('ROLLBACK');return null;}
  const result=existingId
   ? await db.query('UPDATE commercials SET name=$2,active=$3,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id,name,active',[id,data.name,data.active])
   : await db.query('INSERT INTO commercials(id,name,active) VALUES($1,$2,$3) RETURNING id,name,active',[id,data.name,data.active]);
  const saved=result.rows[0];
  // Une désactivation ou réactivation révoque définitivement les sessions précédentes.
  if (old && old.rows[0].active !== saved.active) await db.query('UPDATE commercial_credentials SET session_version=session_version+1 WHERE commercial_id=$1',[id]);
  const changed=old ? ['name','active'].filter(key=>old.rows[0][key]!==saved[key]) : [];
  await db.query('INSERT INTO audit_log(id,actor,action,entity,entity_id,entity_name,changed_fields) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),actor,existingId?'modification':'création','commercials',id,saved.name,changed]);
  await db.query('COMMIT'); return saved;
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
