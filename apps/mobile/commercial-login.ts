/** Test isolé : aucun jeton n'est enregistré ou utilisé pour synchroniser. */
type ResponseLike={ok:boolean;status:number;json:()=>Promise<unknown>};
type FetchLike=(url:string,options:{method:string;headers:Record<string,string>;body?:string})=>Promise<ResponseLike>;
function apiOrigin(value:string) {
 let url:URL;
 try {url=new URL(value.trim());} catch {throw Error('Adresse de l’API invalide.');}
 if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname!=='/' || url.search || url.hash || ['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname)) throw Error('Saisissez l’adresse réseau de l’API, par exemple http://192.168.1.10:3001.');
 return url.origin;
}
function object(value:unknown):Record<string,unknown>|null {return typeof value==='object' && value!==null && !Array.isArray(value)?value as Record<string,unknown>:null;}
export async function testCommercialLogin(address:string,login:string,password:string,request:FetchLike):Promise<{id:string;name:string}> {
 const origin=apiOrigin(address);
 if (!login.trim() || !password) throw Error('Saisissez l’identifiant et le mot de passe de test.');
 const response=await request(`${origin}/api/mobile/session/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login,password})});
 if (!response.ok) throw Error(response.status===401?'Identifiant ou mot de passe incorrect.':`Connexion impossible (${response.status}).`);
 const data=object(await response.json().catch(()=>null));
 if(typeof data?.token!=='string' || !data.token || data.token.length>8192) throw Error('Réponse de connexion invalide.');
 const verified=await request(`${origin}/api/mobile/session`,{method:'GET',headers:{Authorization:`Bearer ${data.token}`}});
 if(!verified.ok) throw Error('Session refusée ou expirée.');
 const body=object(await verified.json().catch(()=>null)); const user=object(body?.commercial);
 if(typeof user?.id!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id) || typeof user.name!=='string' || !user.name.trim() || user.name.length>200) throw Error('Réponse de session invalide.');
 return {id:user.id,name:user.name};
}
