/** Orchestration expérimentale réservée à une compensation. Le serveur et la
 * session doivent être authentifiés par l'appelant ; cette fonction n'active
 * ni les écrans ni les lecteurs de solde ou de clôture historiques. */
import {canonicalJson} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import {acquireDayInvoiceSync,releaseDayInvoiceSync} from './day-invoice-sync-lock';
import {readLocalCompensation,acknowledgeLocalCompensation} from './day-invoice-compensation-local';
import {uploadCompensatedSale} from './day-invoice-compensation-upload';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
type IO={transaction:<T>(work:(tx:Tx)=>Promise<T>)=>Promise<T>;
 /** Vérifie en ligne commercial, origine et lignée épinglée avant tout envoi. */
 verifyServer:(identity:DeviceIdentity,check:()=>void)=>Promise<void>;
 /** Lève si la session ou sa liaison a changé ou expiré. */
 check:()=>void;
 send:(payload:string)=>Promise<Response>;
 receipt:(operationId:string)=>Promise<Response>;
};
export async function synchronizeLocalCompensation(identity:DeviceIdentity,verified:DeviceIdentity,io:IO){
 acquireDayInvoiceSync();
 try{
  const check=()=>{io.check();if(identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur différent du téléphone lié.');};
  check();await io.verifyServer(identity,check);check();
  const read=()=>io.transaction(async tx=>{check();const value=await readLocalCompensation(tx,identity);check();return value;});
  const pending=await read();if(!pending)return {status:'empty' as const};
  if(pending.receipt!==null)return {status:'already-proven' as const,operationId:pending.input.operationId};
  const wrap=async(work:()=>Promise<Response>)=>{check();const response=await work();check();return {ok:response.ok,status:response.status,json:async()=>{check();const body=await response.json();check();return body;}};};
  await uploadCompensatedSale(pending.payload,identity,verified,{check,send:payload=>wrap(()=>io.send(payload)),receipt:id=>wrap(()=>io.receipt(id)),acknowledge:async(payload,receipt)=>{
   await io.transaction(async tx=>{check();const current=await readLocalCompensation(tx,identity);
    if(!current||current.payload!==pending.payload||canonicalJson(current.input)!==canonicalJson(pending.input)||current.receipt!==null)throw Error('Compensation locale modifiée pendant le transfert.');
    await acknowledgeLocalCompensation(tx,identity,payload,receipt);check();
    const saved=await readLocalCompensation(tx,identity);if(!saved||saved.payload!==payload||saved.receipt===null||canonicalJson(saved.receipt)!==canonicalJson(receipt))throw Error('Reçu local indisponible.');check();
   });
  }});
  check();return {status:'proven' as const,operationId:pending.input.operationId};
 }finally{releaseDayInvoiceSync();}
}
