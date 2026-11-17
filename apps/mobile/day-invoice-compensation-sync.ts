/** Orchestration expérimentale des compensations indépendantes. Le serveur et
 * la session doivent être authentifiés ; aucune fonction ici n'active les
 * écrans ni les lecteurs de solde ou de clôture historiques. */
import {canonicalJson} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import {acquireDayInvoiceSync,releaseDayInvoiceSync} from './day-invoice-sync-lock';
import {readLocalCompensation,readLocalCompensationById,readLocalCompensations,acknowledgeLocalCompensation} from './day-invoice-compensation-local';
import {readLocalCompensationView,readLocalIndependentCompensationViews} from './day-invoice-compensation-view';
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
async function synchronizeOne(identity:DeviceIdentity,verified:DeviceIdentity,io:IO,operationId?:string){
  const check=()=>{io.check();if(identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur différent du téléphone lié.');};
  check();await io.verifyServer(identity,check);check();
  const readOne=(tx:Tx)=>operationId===undefined?readLocalCompensation(tx,identity):readLocalCompensationById(tx,identity,operationId);
  const read=()=>io.transaction(async tx=>{check();const value=await readOne(tx);if(value)await readLocalCompensationView(tx,identity,operationId);check();return value;});
  const pending=await read();if(!pending)return {status:'empty' as const};
  if(pending.receipt!==null)return {status:'already-proven' as const,operationId:pending.input.operationId};
  const wrap=async(work:()=>Promise<Response>)=>{check();const response=await work();check();return {ok:response.ok,status:response.status,json:async()=>{check();const body=await response.json();check();return body;}};};
  await uploadCompensatedSale(pending.payload,identity,verified,{check,send:payload=>wrap(()=>io.send(payload)),receipt:id=>wrap(()=>io.receipt(id)),acknowledge:async(payload,receipt)=>{
   await io.transaction(async tx=>{check();const current=await readOne(tx);
    if(!current||current.payload!==pending.payload||canonicalJson(current.input)!==canonicalJson(pending.input)||current.receipt!==null)throw Error('Compensation locale modifiée pendant le transfert.');
    await readLocalCompensationView(tx,identity,operationId);check();
    await acknowledgeLocalCompensation(tx,identity,payload,receipt,operationId);check();
    const saved=await readOne(tx);if(!saved||saved.payload!==payload||saved.receipt===null||canonicalJson(saved.receipt)!==canonicalJson(receipt))throw Error('Reçu local indisponible.');check();
   });
  }});
  check();return {status:'proven' as const,operationId:pending.input.operationId};
}
export async function synchronizeLocalCompensation(identity:DeviceIdentity,verified:DeviceIdentity,io:IO,operationId?:string){
 acquireDayInvoiceSync();try{return await synchronizeOne(identity,verified,io,operationId);}finally{releaseDayInvoiceSync();}
}
/** Reprise séquentielle expérimentale de clients indépendants. Chaque reçu
 * est enregistré séparément : une panne conserve les autres choix intacts et
 * une reprise ne réémet pas les opérations déjà acquittées. Aucun garde des
 * écrans ni des soldes normaux n'est levé par cette fonction. */
export async function synchronizeIndependentLocalCompensations(identity:DeviceIdentity,verified:DeviceIdentity,io:IO){
 acquireDayInvoiceSync();
 try{
  const check=()=>{io.check();if(identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur différent du téléphone lié.');};
  check();await io.verifyServer(identity,check);check();
  const initial=await io.transaction(async tx=>{
   check();const entries=await readLocalCompensations(tx,identity),views=await readLocalIndependentCompensationViews(tx,identity);check();
   if(entries.length!==views.length||entries.some((entry,i)=>entry.input.operationId!==views[i].operationId))throw Error('Inventaire de compensation incohérent.');
   return entries.map(entry=>({operationId:entry.input.operationId,payload:entry.payload,input:canonicalJson(entry.input)}));
  });
  const results:{operationId:string;status:'proven'|'already-proven'}[]=[];
  for(const entry of initial){
   check();await io.transaction(async tx=>{check();const current=await readLocalCompensationById(tx,identity,entry.operationId);
    if(!current||current.payload!==entry.payload||canonicalJson(current.input)!==entry.input)throw Error('Compensation modifiée pendant la reprise.');check();});
   const result=await synchronizeOne(identity,verified,io,entry.operationId);
   if(result.status==='empty'||result.operationId!==entry.operationId)throw Error('Compensation indisponible pendant la reprise.');
   results.push(result);
  }
  check();return results;
 }finally{releaseDayInvoiceSync();}
}
