/** La connexion vérifie l’identité en ligne ; le mot de passe n’est jamais conservé. */
type ResponseLike={ok:boolean;status:number;json:()=>Promise<unknown>};
type FetchLike=(url:string,options:{method:string;headers:Record<string,string>;body?:string})=>Promise<ResponseLike>;
export function apiOrigin(value:string) {
 let url:URL;
 try {url=new URL(value.trim());} catch {throw Error('Adresse de l’API invalide.');}
 if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname!=='/' || url.search || url.hash || ['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname)) throw Error('Saisissez l’adresse réseau de l’API, par exemple http://192.168.1.10:3001.');
 return url.origin;
}
function object(value:unknown):Record<string,unknown>|null {return typeof value==='object' && value!==null && !Array.isArray(value)?value as Record<string,unknown>:null;}
export type CommercialSession={id:string;name:string;serverOrigin:string;token:string;expiresAt:string};
export async function openCommercialSession(address:string,login:string,password:string,request:FetchLike):Promise<CommercialSession> {
 const origin=apiOrigin(address);
 if (!login.trim() || !password) throw Error('Saisissez l’identifiant et le mot de passe de test.');
 const response=await request(`${origin}/api/mobile/session/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login,password})});
 if (!response.ok) throw Error(response.status===401?'Identifiant ou mot de passe incorrect.':`Connexion impossible (${response.status}).`);
 const data=object(await response.json().catch(()=>null));
 if(typeof data?.token!=='string' || !data.token || data.token.length>8192) throw Error('Réponse de connexion invalide.');
 if(typeof data.expiresAt!=='string' || !Number.isFinite(Date.parse(data.expiresAt)) || new Date(data.expiresAt).toISOString()!==data.expiresAt) throw Error('Expiration de session invalide : mettez à jour le serveur.');
 const verified=await request(`${origin}/api/mobile/session`,{method:'GET',headers:{Authorization:`Bearer ${data.token}`}});
 if(!verified.ok) throw Error('Session refusée ou expirée.');
 const body=object(await verified.json().catch(()=>null)); const user=object(body?.commercial);
 if(typeof user?.id!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id) || typeof user.name!=='string' || !user.name.trim() || user.name.length>200) throw Error('Réponse de session invalide.');
 return {id:user.id,name:user.name,serverOrigin:origin,token:data.token,expiresAt:data.expiresAt};
}
/** L'écran de test ne conserve pas le jeton après vérification. */
export async function testCommercialLogin(address:string,login:string,password:string,request:FetchLike):Promise<{id:string;name:string}> {
 const {id,name}=await openCommercialSession(address,login,password,request);return {id,name};
}

/** Hors procédure de changement d'adresse, ne jamais envoyer le mot de passe
 * à une autre origine que celle liée dans SQLite. La lecture est volontairement
 * effectuée avant tout réseau ; une erreur de stockage bloque la connexion. */
export async function openBoundCommercialSession(address:string,login:string,password:string,request:FetchLike,readIdentity:()=>Promise<{commercialId:string;serverOrigin:string}|null>):Promise<CommercialSession>{
 const target=apiOrigin(address),bound=await readIdentity();
 if(bound&&bound.serverOrigin!==target)throw Error('Ce téléphone est lié à une autre adresse. Utilisez « Changer l’adresse du serveur » ; aucun identifiant n’a été envoyé.');
 const session=await openCommercialSession(target,login,password,request);
 const current=await readIdentity();
 if((bound?.commercialId??null)!==(current?.commercialId??null)||(bound?.serverOrigin??null)!==(current?.serverOrigin??null))throw Error('La liaison a changé pendant la connexion : réessayez.');
 if(current&&session.id!==current.commercialId)throw Error('Ce téléphone est lié à un autre commercial : connexion refusée.');
 return session;
}
