/** Transport v5 préparatoire : pas encore branché aux écrans ni au serveur
 * courant. Les opérations locales et leurs accusés restent gérés par SQLite. */
import {validSession} from './secure-commercial-session';
import type {CommercialSession} from './commercial-login';
import type {DeviceIdentity} from './identified-device';
import {sendPreparedTourClose,type Attempt} from './tour-close-queue';

type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
type Request=(url:string,options:{method:'GET'|'POST';headers:Record<string,string>;body?:string})=>Promise<Response>;
type Transport={fetchReference:()=>Promise<unknown>;sendOperation:(path:string,body:string)=>Promise<Response>;sendCredit:(path:string,body:string)=>Promise<Response>};
type Dependencies={
 request:Request;
 cacheReference:(identity:DeviceIdentity,verified:DeviceIdentity,value:unknown,guard:()=>void)=>Promise<void>;
 bindReference?:(identity:DeviceIdentity,verified:DeviceIdentity,value:unknown,guard:()=>void)=>Promise<void>;
 cacheSources:(identity:DeviceIdentity,verified:DeviceIdentity,clientId:string,value:unknown,guard:()=>void)=>Promise<void>;
 synchronize:(identity:DeviceIdentity,verified:DeviceIdentity,transport:Transport,guard:()=>void)=>Promise<{operations:number;credits:number}>;
 tour?:{
  getAttempt:(identity:DeviceIdentity,day:string,guard:()=>void)=>Promise<Attempt|null>;
  prepare:(identity:DeviceIdentity,day:string,version:number,guard:()=>void)=>Promise<Attempt>;
  acknowledge:(identity:DeviceIdentity,day:string,response:unknown,guard:()=>void)=>Promise<void>;
  observe:(identity:DeviceIdentity,day:string,response:unknown,guard:()=>void)=>Promise<void>;
 };
 now?:()=>number;
 onUnauthorized?:()=>void;
};
const uuid=(v:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const validDay=(v:string)=>{const d=new Date(`${v}T00:00:00.000Z`);return /^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;};
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
 const tour=()=>{if(!io.tour)throw Error('Clôture v5 indisponible.');return io.tour;};
 const readDay=async(day:string)=>{
  if(!validDay(day))throw Error('Date de tournée invalide.');
  const value=await read(`day/${day}`);check();await tour().observe(identity,day,value,check);check();
  const state=object(value);if(!state||(state.status!=='open'&&state.status!=='closed')||!Number.isSafeInteger(state.version))throw Error('État de tournée invalide.');
  return {status:state.status,version:state.version as number};
 };
 const transport:Transport={fetchReference,sendOperation:(path,body)=>{if(!['sales','settlements','journal'].includes(path))throw Error('Type d’opération invalide.');return request(path,'POST',body);},sendCredit:(path,body)=>{if(!['sales','preinvoices'].includes(path))throw Error('Type d’avoir invalide.');return request(`credit-notes/${path}`,'POST',body);}};
 return {
  connect:()=>exclusive(async()=>{if(!io.bindReference)throw Error('Liaison v5 indisponible.');const value=await fetchReference();check();await io.bindReference(identity,identity,value,check);check();}),
  refreshReference:()=>exclusive(async()=>{const value=await fetchReference();check();await io.cacheReference(identity,identity,value,check);check();}),
  refreshSources:(clientId:string)=>exclusive(async()=>{
   if(!uuid(clientId))throw Error('Client invalide.');
   const reference=await fetchReference();check();await io.cacheReference(identity,identity,reference,check);check();
   const sources=await read(`credit-sources/${encodeURIComponent(clientId)}`);check();await io.cacheSources(identity,identity,clientId,sources,check);check();
  }),
  synchronize:()=>exclusive(async()=>{check();const result=await io.synchronize(identity,identity,transport,check);check();return result;}),
  refreshDay:(day:string)=>exclusive(()=>readDay(day)),
  closeDay:(day:string)=>exclusive(async()=>{
   if(!validDay(day))throw Error('Date de tournée invalide.');check();
   let attempt=await tour().getAttempt(identity,day,check);check();
   if(attempt?.status==='closed')throw Error('Journée déjà clôturée.');
   if(!attempt){const state=await readDay(day);if(state.status!=='open')throw Error('Journée déjà clôturée.');attempt=await tour().prepare(identity,day,state.version,check);}
   else attempt=await tour().prepare(identity,day,attempt.expectedVersion,check);
   check();await sendPreparedTourClose(attempt,body=>request('close','POST',JSON.stringify(body)),body=>tour().acknowledge(identity,day,body,check));check();
   return readDay(day);
  })
 };
}
