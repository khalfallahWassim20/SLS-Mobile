/** Transport v5 préparatoire : pas encore branché aux écrans ni au serveur
 * courant. Les opérations locales et leurs accusés restent gérés par SQLite. */
import {validSession} from './secure-commercial-session';
import type {CommercialSession} from './commercial-login';
import type {DeviceIdentity} from './identified-device';

type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
type Request=(url:string,options:{method:'GET'|'POST';headers:Record<string,string>;body?:string})=>Promise<Response>;
type Transport={fetchReference:()=>Promise<unknown>;sendOperation:(path:string,body:string)=>Promise<Response>;sendCredit:(path:string,body:string)=>Promise<Response>};
type Dependencies={
 request:Request;
 cacheReference:(identity:DeviceIdentity,verified:DeviceIdentity,value:unknown,guard:()=>void)=>Promise<void>;
 cacheSources:(identity:DeviceIdentity,verified:DeviceIdentity,clientId:string,value:unknown,guard:()=>void)=>Promise<void>;
 synchronize:(identity:DeviceIdentity,verified:DeviceIdentity,transport:Transport,guard:()=>void)=>Promise<{operations:number;credits:number}>;
 now?:()=>number;
 onUnauthorized?:()=>void;
};
const uuid=(v:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
let controllerBusy=false;
/** Le contrôleur ne crée pas de session et ne conserve pas de mot de passe.
 * Une réponse reçue après expiration n'est jamais acquittée localement. */
export function createCreditTransportPrototype(session:CommercialSession,identity:DeviceIdentity,io:Dependencies){
 const now=io.now??Date.now;
 session={...session};identity={...identity};
 let revoked=false;
 const check=()=>{if(revoked||!validSession(session,identity,now()))throw Error('Session expirée ou identité différente : reconnectez-vous pour synchroniser.');};
 const request=async(path:string,method:'GET'|'POST',body?:string)=>{
  check();
  const response=await io.request(`${session.serverOrigin}/api/mobile/identified/${path}`,{method,headers:{Authorization:`Bearer ${session.token}`,'X-SLS-Reference-Version':'5',...(method==='POST'?{'Content-Type':'application/json'}:{})},...(body===undefined?{}:{body})});
  if(response.status===401){revoked=true;io.onUnauthorized?.();throw Error('Session refusée : reconnectez-vous pour synchroniser.');}
  check();return {ok:response.ok,status:response.status,json:async()=>{check();const value=await response.json();check();return value;}};
 };
 const read=async(path:string)=>{
  const response=await request(path,'GET');const body=await response.json().catch(()=>null);check();
  if(!response.ok){const e=object(body);throw Error(typeof e?.error==='string'&&e.error?e.error.slice(0,300):`Erreur serveur (${response.status}).`);}
  return body;
 };
 const fetchReference=()=>read('reference');
 const exclusive=async<T>(fn:()=>Promise<T>)=>{if(controllerBusy)throw Error('Synchronisation ou actualisation déjà en cours.');controllerBusy=true;try{return await fn();}finally{controllerBusy=false;}};
 const transport:Transport={fetchReference,sendOperation:(path,body)=>{if(!['sales','settlements','journal'].includes(path))throw Error('Type d’opération invalide.');return request(path,'POST',body);},sendCredit:(path,body)=>{if(!['sales','preinvoices'].includes(path))throw Error('Type d’avoir invalide.');return request(`credit-notes/${path}`,'POST',body);}};
 return {
  refreshReference:()=>exclusive(async()=>{const value=await fetchReference();check();await io.cacheReference(identity,identity,value,check);check();}),
  refreshSources:(clientId:string)=>exclusive(async()=>{
   if(!uuid(clientId))throw Error('Client invalide.');
   const reference=await fetchReference();check();await io.cacheReference(identity,identity,reference,check);check();
   const sources=await read(`credit-sources/${encodeURIComponent(clientId)}`);check();await io.cacheSources(identity,identity,clientId,sources,check);check();
  }),
  synchronize:()=>exclusive(async()=>{check();const result=await io.synchronize(identity,identity,transport,check);check();return result;})
 };
}
