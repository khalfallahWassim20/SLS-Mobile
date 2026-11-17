/** Transport expérimental v6. La lignée seule ne prouve pas qu'une base n'a
 * pas été clonée ou restaurée ; HTTP privé ne protège pas contre l'usurpation.
 * Le protocole et ce transport ne sont pas raccordés à l'application normale. */
import {validSession} from './secure-commercial-session';
import {isPrivateHttpOrigin} from './private-api-origin';
import type {CommercialSession} from './commercial-login';
import type {DeviceIdentity} from './identified-device';
import type {LineagePin} from './server-lineage-proof';
type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
type Request=(url:string,options:{method:'GET'|'POST';headers:Record<string,string>;body?:string})=>Promise<Response>;
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
export function createDayInvoiceTransportPrototype(session:CommercialSession,identity:DeviceIdentity,pinned:LineagePin|null,io:{request:Request;isCurrentSession:()=>boolean;allowPrivateHttp?:boolean;now?:()=>number;onUnauthorized?:()=>void}){
 session={...session};identity={...identity};pinned=pinned?{...pinned}:null;
 let revoked=false;const now=io.now??Date.now;
 const check=()=>{if(revoked||!io.isCurrentSession()||!validSession(session,identity,now()))throw Error('Session expirée ou identité différente : reconnectez-vous pour synchroniser.');};
 const request=async(path:string,method:'GET'|'POST',body?:string):Promise<Response>=>{
  check();const response=await io.request(`${identity.serverOrigin}/api/mobile/identified/${path}`,{method,headers:{Authorization:`Bearer ${session.token}`,...(method==='POST'?{'Content-Type':'application/json'}:{})},...(body===undefined?{}:{body})});
  if(response.status===401){revoked=true;io.onUnauthorized?.();throw Error('Session refusée : reconnectez-vous pour synchroniser.');}
  check();return {ok:response.ok,status:response.status,json:async()=>{check();const result=await response.json();check();return result;}};
 };
 let proven=false;
 const verifyServer=async(bound:DeviceIdentity,guard:()=>void)=>{
  proven=false;check();guard();
  if(bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin||!pinned||pinned.commercialId!==identity.commercialId||pinned.serverOrigin!==identity.serverOrigin||!uuid(pinned.lineageId))throw Error('Lignée préalable indisponible : rapprochement nécessaire.');
  if(!identity.serverOrigin.startsWith('https://')&&!(io.allowPrivateHttp&&isPrivateHttpOrigin(identity.serverOrigin)))throw Error('HTTPS requis ou HTTP privé explicitement autorisé.');
  const response=await request('server-lineage','GET');const value=object(await response.json().catch(()=>null));guard();check();
  if(!response.ok||!value||value.version!==1||value.commercialId!==identity.commercialId||value.lineageId!==pinned.lineageId)throw Error('Lignée serveur incohérente : synchronisation refusée.');
  proven=true;
 };
 const verified=()=>{check();if(!proven)throw Error('Lignée serveur non vérifiée.');};
 return {check,verifyServer,
  fetchReference:async()=>{verified();const response=await request('day-invoice-reference','GET');const value=await response.json().catch(()=>null);verified();if(!response.ok){const e=object(value);throw Error(typeof e?.error==='string'?e.error.slice(0,300):`Référence indisponible (${response.status}).`);}return value;},
  sendSource:(path:string,payload:string)=>{verified();if(!['sales','settlements','journal'].includes(path))throw Error('Type d’opération invalide.');return request(path==='settlements'?path:`day-invoice-sources/${path}`,'POST',payload);},
  sendPayment:(payload:string)=>{verified();return request('day-invoice-payments','POST',payload);},
  sendOldDebt:(payload:string)=>{verified();return request('day-invoice-old-debt','POST',payload);},
  sendCompensation:(payload:string)=>{verified();return request('day-invoice-compensated-sale','POST',payload);},
  readCompensationReceipt:(operationId:string)=>{verified();if(!uuid(operationId))throw Error('Identifiant de compensation invalide.');return request(`day-invoice-compensated-sale/${operationId}/receipt`,'GET');},
  readCompensatedInvoice:(operationId:string)=>{verified();if(!uuid(operationId))throw Error('Identifiant de compensation invalide.');return request(`day-invoice-compensated-sale/${operationId}/invoice`,'GET');},
  readCompensatedJournal:(operationId:string)=>{verified();if(!uuid(operationId))throw Error('Identifiant de compensation invalide.');return request(`day-invoice-compensated-sale/${operationId}/journal`,'GET');},
  sendClose:(payload:string)=>{verified();return request('day-invoice-close','POST',payload);},
  abandonClose:(payload:string)=>{verified();return request('day-invoice-close/abandon','POST',payload);},
  readDay:async(day:string)=>{verified();const date=new Date(`${day}T00:00:00.000Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day)throw Error('Date de journée invalide.');return request(`day/${day}`,'GET');},
  readExpenseSnapshot:async(day:string)=>{verified();const date=new Date(`${day}T00:00:00.000Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day)throw Error('Date de journée invalide.');return request(`expense-snapshot/${day}`,'GET');}
 };
}
