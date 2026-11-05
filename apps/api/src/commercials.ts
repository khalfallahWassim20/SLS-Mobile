/** Référentiel de démonstration uniquement : aucun identifiant de connexion n'est créé. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
export const commercialInputSchema=z.object({name:z.string().trim().min(1).max(200),active:z.boolean()}).strict();
export type CommercialInput=z.infer<typeof commercialInputSchema>;
export async function listCommercials(pool:Pool) {
 const r=await pool.query('SELECT id,name,active FROM commercials WHERE deleted_at IS NULL ORDER BY name,id LIMIT 10000');
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
  const changed=old ? ['name','active'].filter(key=>old.rows[0][key]!==saved[key]) : [];
  await db.query('INSERT INTO audit_log(id,actor,action,entity,entity_id,entity_name,changed_fields) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),actor,existingId?'modification':'création','commercials',id,saved.name,changed]);
  await db.query('COMMIT'); return saved;
 } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
