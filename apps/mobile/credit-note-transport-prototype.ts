/** Transport v5 de test isolé. Les opérations et leurs accusés restent gérés par SQLite. */
import {compareCashReconciliation} from '@sls/domain';
import {validSession} from './secure-commercial-session';
import type {CommercialSession} from './commercial-login';
import type {reconcileLocalSalePrototype} from './local-sale-reconcile-prototype';
import type {inspectLocalSaleHistoryPrototype} from './local-sale-history-prototype';
import type {recoverReceivedRemoteEditPrototype} from './credit-remote-sale-confirm-prototype';
import type {comparePendingRemoteEditPrototype} from './credit-remote-sale-confirm-prototype';
import type {IdentifiedEntry} from './identified-upload';
import type {DeviceIdentity} from './identified-device';
import type {Note} from './credit-note-offline-prototype';
import {compareSaleCashEvents} from './credit-sale-cash-compare-prototype';
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
 localSaleReconcile?:(identity:DeviceIdentity,verified:DeviceIdentity,localId:number,saleId:string,response:unknown,fingerprint:string,guard:()=>void)=>Promise<Awaited<ReturnType<typeof reconcileLocalSalePrototype>>>;
 localSaleInspect?:(identity:DeviceIdentity,verified:DeviceIdentity,localId:number,saleId:string,response:unknown,guard:()=>void)=>Promise<Awaited<ReturnType<typeof inspectLocalSaleHistoryPrototype>>>;
 remoteRecover?:(identity:DeviceIdentity,verified:DeviceIdentity,operationId:string,response:unknown,guard:()=>void)=>Promise<Awaited<ReturnType<typeof recoverReceivedRemoteEditPrototype>>>;
 remoteCompare?:(identity:DeviceIdentity,verified:DeviceIdentity,operationId:string,reference:unknown,sources:unknown,guard:()=>void)=>Promise<Awaited<ReturnType<typeof comparePendingRemoteEditPrototype>>>;
 creditAbandon?:{read:(identity:DeviceIdentity,operationId:string,guard:()=>void)=>Promise<Note>;resolve:(identity:DeviceIdentity,verified:DeviceIdentity,note:Note,response:unknown,reference:unknown,guard:()=>void)=>Promise<void>};
 remoteAbandon?:{
  read:(identity:DeviceIdentity,guard:()=>void)=>Promise<{entry:IdentifiedEntry;event:unknown}>;
  resolve:(identity:DeviceIdentity,verified:DeviceIdentity,entry:IdentifiedEntry,response:unknown,reference:unknown,guard:()=>void)=>Promise<void>;
 };
 saleCash?: (identity:DeviceIdentity,day:string,guard:()=>void)=>Promise<unknown>;
 journalCash?: (identity:DeviceIdentity,day:string,guard:()=>void)=>Promise<unknown>;
 tour?:{
  getAttempt:(identity:DeviceIdentity,day:string,guard:()=>void)=>Promise<Attempt|null>;
  prepare:(identity:DeviceIdentity,day:string,version:number,guard:()=>void)=>Promise<Attempt>;
  acknowledge:(identity:DeviceIdentity,day:string,response:unknown,guard:()=>void)=>Promise<void>;
  discard?:(identity:DeviceIdentity,day:string,attempt:Attempt,response:unknown,guard:()=>void)=>Promise<void>;
  observe:(identity:DeviceIdentity,day:string,response:unknown,guard:()=>void)=>Promise<void>;
 };
 now?:()=>number;
 isCurrentSession?:()=>boolean;
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
 const check=()=>{if(revoked||io.isCurrentSession?.()===false||!validSession(session,identity,now()))throw Error('Session expirée ou identité différente : reconnectez-vous pour synchroniser.');};
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
  reconcileLocalSale:(localId:number,saleId:string,fingerprint:string)=>exclusive(async()=>{
   if(!io.localSaleReconcile||!Number.isSafeInteger(localId)||localId<1||!uuid(saleId)||! /^[0-9a-f]{64}$/.test(fingerprint))throw Error('Rapprochement indisponible.');check();
   const response=await read(`local-sales/${encodeURIComponent(saleId)}/history`);check();
   const result=await io.localSaleReconcile(identity,identity,localId,saleId,response,fingerprint,check);check();return result;
  }),
  inspectLocalSale:(localId:number,saleId:string)=>exclusive(async()=>{
   if(!io.localSaleInspect||!Number.isSafeInteger(localId)||localId<1||!uuid(saleId))throw Error('Comparaison indisponible.');check();
   const response=await read(`local-sales/${encodeURIComponent(saleId)}/history`);check();
   const result=await io.localSaleInspect(identity,identity,localId,saleId,response,check);check();return result;
  }),
  recoverRemoteEdit:(operationId:string)=>exclusive(async()=>{
   if(!io.remoteRecover||!uuid(operationId))throw Error('Vérification indisponible.');check();
   const response=await read(`remote-sale-edits/${encodeURIComponent(operationId)}/receipt`);check();
   const result=await io.remoteRecover(identity,identity,operationId,response,check);check();return result;
  }),
  compareRemoteEdit:(operationId:string,clientId:string)=>exclusive(async()=>{
   if(!io.remoteCompare||!uuid(operationId)||!uuid(clientId))throw Error('Comparaison indisponible.');check();
   const reference=await fetchReference();check();const sources=await read(`credit-sources/${encodeURIComponent(clientId)}`);check();
   return io.remoteCompare(identity,identity,operationId,reference,sources,check);
  }),
  abandonCredit:(operationId:string)=>exclusive(async()=>{
   if(!io.creditAbandon||!uuid(operationId))throw Error('Abandon d’avoir indisponible.');check();
   const note=await io.creditAbandon.read(identity,operationId,check);check();
   const response=await request('credit-notes-abandon','POST',JSON.stringify({kind:note.kind,command:note.command}));const body=await response.json().catch(()=>null);check();
   if(!response.ok){const e=object(body);throw Error(typeof e?.error==='string'?e.error:`Erreur serveur (${response.status}).`);}
   const result=object(body);if(!result||Object.keys(result).sort().join(',')!=='invoiceId,kind,operationId,status'||result.operationId!==operationId||result.invoiceId!==note.command.invoiceId||result.kind!==note.kind)throw Error('Accusé invalide : avoir conservé.');
   if(result.status==='already-received')return 'already-received' as const;
   if(result.status!=='abandoned')throw Error('Accusé invalide : avoir conservé.');
   const reference=await fetchReference();check();await io.creditAbandon.resolve(identity,identity,note,body,reference,check);check();return 'abandoned' as const;
  }),
  abandonRemoteEdit:()=>exclusive(async()=>{
   if(!io.remoteAbandon)throw Error('Abandon sécurisé indisponible.');check();
   const candidate=await io.remoteAbandon.read(identity,check);check();
   const response=await request('remote-sale-edits/abandon','POST',JSON.stringify(candidate.event));const body=await response.json().catch(()=>null);check();
   if(!response.ok){const e=object(body);throw Error(typeof e?.error==='string'?e.error:`Erreur serveur (${response.status}).`);}
   const result=object(body),event=object(candidate.event);
   if(!result||!event||result.operationId!==candidate.entry.operationId||result.saleId!==candidate.entry.entityId||result.version!==event.version||Object.keys(result).sort().join(',')!=='operationId,saleId,status,version')throw Error('Accusé d’abandon invalide.');
   if(result.status==='already-received')return 'already-received' as const;
   if(result.status!=='abandoned')throw Error('Accusé d’abandon invalide.');
   const reference=await fetchReference();check();await io.remoteAbandon.resolve(identity,identity,candidate.entry,body,reference,check);check();return 'abandoned' as const;
  }),
  synchronize:()=>exclusive(async()=>{check();const result=await io.synchronize(identity,identity,transport,check);check();return result;}),
  compareSaleCash:(day:string)=>exclusive(async()=>{
   if(!validDay(day)||!io.saleCash)throw Error('Comparaison de caisse indisponible.');
   const server=await read(`day/${day}/sale-cash`);check();const local=await io.saleCash(identity,day,check);check();return compareSaleCashEvents(local,server,identity,day);
  }),
  compareJournalCash:(day:string)=>exclusive(async()=>{
   if(!validDay(day)||!io.journalCash)throw Error('Comparaison du journal indisponible.');
   const server=await read(`day/${day}/journal-cash`);check();const local=await io.journalCash(identity,day,check);check();return compareCashReconciliation(local,server,identity.commercialId,day);
  }),
  refreshDay:(day:string)=>exclusive(()=>readDay(day)),
  closeDay:(day:string)=>exclusive(async()=>{
   if(!validDay(day))throw Error('Date de tournée invalide.');check();
   let attempt=await tour().getAttempt(identity,day,check);check();
   if(attempt?.status==='closed')throw Error('Journée déjà clôturée.');
   if(!attempt){const state=await readDay(day);if(state.status!=='open')throw Error('Journée déjà clôturée.');attempt=await tour().prepare(identity,day,state.version,check);}
   else {
    const prior=attempt;
    try{attempt=await tour().prepare(identity,day,prior.expectedVersion,check);}
    catch(error){
     if(!tour().discard)throw error;
     // La vérification locale peut échouer après une réponse perdue. D'abord
     // demander au serveur si l'UUID est reçu ou réservé, jamais l'effacer seul.
     const response=await request('close/abandon','POST',JSON.stringify({requestId:prior.requestId,day,expectedVersion:prior.expectedVersion}));const body=await response.json().catch(()=>null);check();
     if(!response.ok)throw Error('Vérification de clôture non confirmée : demande conservée.');
     const r=object(body);
     if(r&&Object.keys(r).sort().join(',')==='commercialId,day,expectedVersion,requestId,status'&&r.status==='already-received'&&r.requestId===prior.requestId&&r.commercialId===identity.commercialId&&r.day===day&&r.expectedVersion===prior.expectedVersion){
      await sendPreparedTourClose(prior,b=>request('close','POST',JSON.stringify(b)),b=>tour().acknowledge(identity,day,b,check));check();
      throw Error('La clôture avait déjà été reçue par le serveur. Son accusé est conservé ; les opérations locales nécessitent encore un rapprochement.');
     }
     await tour().discard!(identity,day,prior,body,check);check();
     const detail=error instanceof Error?error.message:'Vérification locale impossible.';
     throw Error(`${detail} La demande de clôture a été abandonnée sans perte ; synchronisez et vérifiez avant de recommencer.`);
    }
   }
   let conflict=false;
   try{check();await sendPreparedTourClose(attempt,async body=>{const result=await request('close','POST',JSON.stringify(body));return {...result,json:async()=>{const value=await result.json();if(result.status===409)conflict=true;return value;}};},body=>tour().acknowledge(identity,day,body,check));check();}
   catch(error){
    if(!conflict||!tour().discard)throw error;
    const response=await request('close/abandon','POST',JSON.stringify({requestId:attempt.requestId,day,expectedVersion:attempt.expectedVersion}));const body=await response.json().catch(()=>null);check();
    if(!response.ok)throw Error('Abandon de clôture non confirmé : demande conservée.');
    await tour().discard!(identity,day,attempt,body,check);check();
    const detail=error instanceof Error?error.message:'Clôture refusée.';
    throw Error(`${detail} Demande de clôture abandonnée sans perte. Synchronisez, vérifiez le journal et l’état de la journée, puis relancez la clôture.`);
   }
   return readDay(day);
  })
 };
}
