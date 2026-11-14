import {validSession} from './secure-commercial-session';
import type {CommercialSession} from './commercial-login';

type Request=(url:string,options:{method:string;headers:Record<string,string>})=>Promise<{ok:boolean;json:()=>Promise<unknown>}>;
/** Découverte facultative et en lecture seule ; un ancien serveur, une erreur
 * ou une session périmée ne doivent jamais autoriser une transition. */
export async function creditBridgeAvailable(session:CommercialSession,request:Request):Promise<boolean>{
 if(!validSession(session,{commercialId:session.id,serverOrigin:session.serverOrigin}))return false;
 try{
  const response=await request(`${session.serverOrigin}/api/mobile/identified/capabilities`,{method:'GET',headers:{Authorization:`Bearer ${session.token}`}});
  if(!response.ok)return false;
  const value=await response.json() as {version?:unknown;commercialId?:unknown;creditBridgeTestOnly?:unknown}|null;
  return validSession(session,{commercialId:session.id,serverOrigin:session.serverOrigin})&&value?.version===1&&value.commercialId===session.id&&value.creditBridgeTestOnly===true;
 }catch{return false;}
}
