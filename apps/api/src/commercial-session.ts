import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';

// Le hash fictif assure un travail bcrypt même si l'identifiant est inconnu.
const DUMMY_HASH='$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxjFBCyh/4O8XQ4O.S5j1HkQwkG';
const inputSchema=z.object({
 login:z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,50}$/),
 password:z.string().min(1).refine(s=>Buffer.byteLength(s,'utf8')<=72)
}).strict();
const audience='sls-commercial-demo';

/** Première seconde de la prochaine date civile en Tunisie, heure du serveur. */
export function nextTunisMidnight(now:Date):Date {
 const current=now.getTime();if(!Number.isFinite(current))throw new RangeError('Date invalide.');
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'});
 const date=(t:number)=>formatter.format(new Date(t));
 const today=date(current);let lo=Math.floor(current/1000),hi=lo+48*60*60;
 if(date(hi*1000)===today)throw new RangeError('Fin de journée introuvable.');
 while(lo+1<hi){const mid=Math.floor((lo+hi)/2);if(date(mid*1000)===today)lo=mid;else hi=mid;}
 return new Date(hi*1000);
}

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
 const now=new Date(),expiresAt=nextTunisMidnight(now),exp=Math.floor(expiresAt.getTime()/1000);
 const token=jwt.sign({role:'commercial',version:row.session_version,exp},secret,{algorithm:'HS256',subject:row.id,audience});
 return {token,commercial:{id:row.id,name:row.name},expiresAt:expiresAt.toISOString(),expiresIn:Math.max(0,exp-Math.floor(now.getTime()/1000))};
}

/** Vérifie la signature puis l'état actuel ; changement de mot de passe ou statut révoque la session. */
export async function verifyCommercialSession(pool:Pool|PoolClient,secret:string,token:string,lock=false) {
 let claims:jwt.JwtPayload;
 try {
  const decoded=jwt.verify(token,secret,{algorithms:['HS256'],audience});
  if (typeof decoded==='string' || decoded.role!=='commercial' || !z.string().uuid().safeParse(decoded.sub).success || typeof decoded.version!=='string' || !/^\d+$/.test(decoded.version) || !Number.isSafeInteger(decoded.iat)) return null;
  // Les anciens jetons émis avant cette mise à jour ne dépassent pas non plus le jour tunisien de leur émission.
  if(Date.now()>=nextTunisMidnight(new Date(decoded.iat! * 1000)).getTime()) return null;
  claims=decoded;
 } catch {return null;}
 const result=await pool.query(`SELECT c.id,c.name FROM commercials c JOIN commercial_credentials cc ON cc.commercial_id=c.id
  WHERE c.id=$1 AND c.active AND c.deleted_at IS NULL AND cc.session_version=$2::bigint${lock ? ' FOR SHARE OF c,cc' : ''}`,[claims.sub,claims.version]);
 return result.rows[0] ?? null;
}
