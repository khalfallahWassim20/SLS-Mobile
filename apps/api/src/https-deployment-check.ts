import {request} from 'node:https';
import {isIP} from 'node:net';
import type {IncomingHttpHeaders} from 'node:http';
import type {TLSSocket} from 'node:tls';
import {checkStrictServerIdentity,parseHttpsOrigin} from './https-identity.js';

type Response={status:number;headers:IncomingHttpHeaders;body:string;fingerprint256:string;protocol:string;expiresAt:string};
/** GET fixe, aucune authentification ; les redirections ne sont jamais suivies. */
async function get(origin:string,path:'/'|'/api/mobile/session',ca?:Buffer,timeoutMs=5000):Promise<Response>{
 const {host,port}=parseHttpsOrigin(origin);
 return new Promise((resolve,reject)=>{
  let finished=false;
  const finish=(error:Error|null,value?:Response)=>{if(finished)return;finished=true;clearTimeout(timer);if(error)reject(error);else resolve(value!);};
  const req=request({hostname:host,port,path,method:'GET',servername:isIP(host)?undefined:host,ca,rejectUnauthorized:true,minVersion:'TLSv1.2',checkServerIdentity:(_name,peer)=>checkStrictServerIdentity(host,peer),agent:false,headers:{Accept:path==='/'?'text/html':'application/json'}},res=>{
   const socket=res.socket as TLSSocket,peer=socket.getPeerCertificate(),protocol=socket.getProtocol();
   if(!socket.authorized||!peer.fingerprint256||!peer.valid_to||!protocol){res.destroy();finish(Error('Certificat TLS indisponible ou non reconnu.'));return;}
   let size=0;const chunks:Buffer[]=[];
   res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>65536){finish(Error('Réponse de diagnostic trop volumineuse.'));res.destroy();return;}chunks.push(chunk);});
   res.once('aborted',()=>finish(Error('Réponse de diagnostic interrompue.')));
   res.once('error',error=>finish(error));
   res.once('end',()=>finish(null,{status:res.statusCode??0,headers:res.headers,body:Buffer.concat(chunks).toString('utf8'),fingerprint256:peer.fingerprint256,protocol,expiresAt:new Date(peer.valid_to).toISOString()}));
  });
  const timer=setTimeout(()=>req.destroy(Error('Délai de diagnostic HTTPS dépassé.')),timeoutMs);
  req.once('error',error=>finish(error));req.end();
 });
}
const noStore=(h:IncomingHttpHeaders)=>typeof h['cache-control']==='string'&&/(?:^|,)\s*no-store\s*(?:,|$)/i.test(h['cache-control']);
/** Contrôle non destructif de l'interface et du refus d'accès sans session.
 * Un succès ne prouve pas l'identité de la base ni la confiance Android. */
export async function checkHttpsDeployment(origin:string,ca?:Buffer,timeoutMs=5000){
 const api=await get(origin,'/api/mobile/session',ca,timeoutMs);
 if(api.status!==401)throw Error(`API : réponse inattendue (${api.status}) ; aucune redirection n'est suivie.`);
 if(!/^application\/json(?:\s*;|$)/i.test(String(api.headers['content-type']??''))||!noStore(api.headers)||api.headers['x-content-type-options']!=='nosniff')throw Error('API : en-têtes de sécurité ou type de réponse manquants.');
 let body:unknown;try{body=JSON.parse(api.body);}catch{throw Error('API : réponse JSON invalide.');}
 if(!body||typeof body!=='object'||Array.isArray(body)||typeof (body as {error?:unknown}).error!=='string')throw Error('API : refus de session non reconnu.');
 const admin=await get(origin,'/',ca,timeoutMs);
 if(admin.status!==200)throw Error(`Administration : réponse inattendue (${admin.status}) ; aucune redirection n'est suivie.`);
 if(admin.fingerprint256!==api.fingerprint256)throw Error('Le certificat a changé pendant le diagnostic : recommencez après vérification.');
 if(!/^text\/html(?:\s*;|$)/i.test(String(admin.headers['content-type']??''))||!noStore(admin.headers)||admin.headers['x-content-type-options']!=='nosniff'||admin.headers['x-frame-options']!=='DENY'||!String(admin.headers['content-security-policy']??'').includes("frame-ancestors 'none'")||!/<div\s+id=["']root["']/i.test(admin.body))throw Error('Administration : interface ou en-têtes de sécurité non reconnus.');
 return {origin,protocol:api.protocol,expiresAt:api.expiresAt,fingerprint256:api.fingerprint256,api:'refus sans session vérifié',admin:'interface et en-têtes reçus',hsts:admin.headers['strict-transport-security']??null};
}
