import {validSession} from './secure-commercial-session';
import type {CommercialSession} from './commercial-login';

type Request=(url:string,options:{method:string;headers:Record<string,string>})=>Promise<{ok:boolean;json:()=>Promise<unknown>}>;
/** Découverte facultative et en lecture seule ; un ancien serveur, une erreur
 * ou une session périmée ne doivent jamais autoriser une transition. */
export type CreditBridgeMode='test'|'pilot';
/** Mode annoncé par le serveur authentifié ; null si le pont n'est pas disponible.
 * Un ancien serveur sans `creditMode` est traité comme un essai. */
export async function creditBridgeMode(session:CommercialSession,request:Request):Promise<CreditBridgeMode|null>{
 if(!validSession(session,{commercialId:session.id,serverOrigin:session.serverOrigin}))return null;
 try{
  const response=await request(`${session.serverOrigin}/api/mobile/identified/capabilities`,{method:'GET',headers:{Authorization:`Bearer ${session.token}`}});
  if(!response.ok)return null;
  const value=await response.json() as {version?:unknown;commercialId?:unknown;creditBridgeTestOnly?:unknown;creditMode?:unknown}|null;
  if(!validSession(session,{commercialId:session.id,serverOrigin:session.serverOrigin})||value?.version!==1||value.commercialId!==session.id||value.creditBridgeTestOnly!==true)return null;
  if(value.creditMode===undefined||value.creditMode==='test')return 'test';
  return value.creditMode==='pilot'?'pilot':null;
 }catch{return null;}
}
export async function creditBridgeAvailable(session:CommercialSession,request:Request):Promise<boolean>{return await creditBridgeMode(session,request)!==null;}
