/** Clôture expérimentale v6 : authentification et lignée, capture immuable,
 * reprise du même UUID après réponse perdue et accusé enregistré atomiquement.
 * Ne monte pas ces routes ni ne contourne les anciennes gardes. */
import {canonicalJson} from '@sls/domain';
import {acquireDayInvoiceSync,releaseDayInvoiceSync} from './day-invoice-sync-lock';
import {findTourCloseAttempt,observeVerifiedTourState,sendPreparedTourClose,type Attempt} from './tour-close-queue';
import {prepareDayInvoiceCloseAttempt,acknowledgeDayInvoiceCloseAttempt} from './day-invoice-close-attempt';
import type {DeviceIdentity} from './identified-device';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
type IO={transaction:<T>(work:(tx:Tx)=>Promise<T>)=>Promise<T>;check:()=>void;verifyServer:(identity:DeviceIdentity,check:()=>void)=>Promise<void>;readDay:(day:string)=>Promise<Response>;sendClose:(payload:string)=>Promise<Response>;digest:(text:string)=>Promise<string>;uuid:()=>string};
export async function closeDayInvoicePrototype(identity:DeviceIdentity,day:string,io:IO):Promise<{day:string;version:number}>{
 acquireDayInvoiceSync();
 try{
  const check=io.check;check();await io.verifyServer(identity,check);check();
  let attempt:Attempt|null=await io.transaction(async tx=>{check();return findTourCloseAttempt(tx,identity.commercialId,day);});check();
  if(attempt?.status==='closed')throw Error('Journée déjà clôturée.');
  if(!attempt){
   const response=await io.readDay(day),state=await response.json().catch(()=>null);check();
   if(!response.ok)throw Error(`État de journée indisponible (${response.status}).`);
   if(!state||typeof state!=='object'||Array.isArray(state))throw Error('État de journée invalide.');
   const s=state as Record<string,unknown>;
   if(s.commercialId!==identity.commercialId||s.day!==day||s.status!=='open'||!Number.isSafeInteger(s.version)||(s.version as number)<0)throw Error('Journée fermée ou état serveur invalide.');
   attempt=await io.transaction(async tx=>{check();await observeVerifiedTourState(tx,identity.commercialId,day,state);check();const value=await prepareDayInvoiceCloseAttempt(tx,identity,day,s.version as number,io.uuid,io.digest);check();return value;});
  }else{
   const previous=attempt;
   attempt=await io.transaction(async tx=>{check();const value=await prepareDayInvoiceCloseAttempt(tx,identity,day,previous.expectedVersion,io.uuid,io.digest);if(canonicalJson(value)!==canonicalJson(previous))throw Error('Tentative de clôture modifiée : reprise refusée.');check();return value;});
  }
  const frozen=attempt;check();
  await sendPreparedTourClose(frozen,async body=>{check();const response=await io.sendClose(JSON.stringify(body));check();return response;},async body=>{check();await io.transaction(async tx=>{check();await acknowledgeDayInvoiceCloseAttempt(tx,identity,day,frozen,body);check();});});
  check();return {day,version:frozen.expectedVersion+1};
 }finally{releaseDayInvoiceSync();}
}
