import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {z} from 'zod';
import type {Pool} from 'pg';

// Le hash fictif assure un travail bcrypt même si l'identifiant est inconnu.
const DUMMY_HASH='$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxjFBCyh/4O8XQ4O.S5j1HkQwkG';
const inputSchema=z.object({
 login:z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,50}$/),
 password:z.string().min(1).refine(s=>Buffer.byteLength(s,'utf8')<=72)
}).strict();
const audience='sls-commercial-demo';

/** Connexion de test isolée : le jeton obtenu n'autorise pas les routes mobiles existantes. */
export async function loginCommercial(pool:Pool,secret:string,input:unknown) {
 const parsed=inputSchema.safeParse(input);
 if (!parsed.success) return null;
 const result=await pool.query(`SELECT c.id,c.name,c.active,cc.password_hash,cc.session_version::text AS session_version
  FROM commercial_credentials cc JOIN commercials c ON c.id=cc.commercial_id
  WHERE cc.login=$1 AND c.deleted_at IS NULL`,[parsed.data.login]);
 const row=result.rows[0];
 const correct=await bcrypt.compare(parsed.data.password,row?.password_hash ?? DUMMY_HASH);
 if (!row || !row.active || !correct) return null;
 const token=jwt.sign({role:'commercial',version:row.session_version},secret,{algorithm:'HS256',subject:row.id,audience,expiresIn:'1h'});
 return {token,commercial:{id:row.id,name:row.name},expiresIn:3600};
}

/** Vérifie la signature puis l'état actuel ; changement de mot de passe ou statut révoque la session. */
export async function verifyCommercialSession(pool:Pool,secret:string,token:string) {
 let claims:jwt.JwtPayload;
 try {
  const decoded=jwt.verify(token,secret,{algorithms:['HS256'],audience});
  if (typeof decoded==='string' || decoded.role!=='commercial' || !z.string().uuid().safeParse(decoded.sub).success || typeof decoded.version!=='string' || !/^\d+$/.test(decoded.version)) return null;
  claims=decoded;
 } catch {return null;}
 const result=await pool.query(`SELECT c.id,c.name FROM commercials c JOIN commercial_credentials cc ON cc.commercial_id=c.id
  WHERE c.id=$1 AND c.active AND c.deleted_at IS NULL AND cc.session_version=$2::bigint`,[claims.sub,claims.version]);
 return result.rows[0] ?? null;
}
