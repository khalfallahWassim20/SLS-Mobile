/** Préparation isolée : ce contrôle ne lance pas de migration et ne constitue
 * pas une preuve cryptographique sur HTTP. Une copie/restauration conserve la
 * même lignée : elle peut être divergente. */
import {apiOrigin,type CommercialSession} from './commercial-login';
import {isPrivateHttpOrigin} from './private-api-origin';
import type {DeviceIdentity} from './identified-device';
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export type LineagePin={commercialId:string;serverOrigin:string;lineageId:string};
type ResponseLike={ok:boolean;status:number;json:()=>Promise<unknown>};
type Request=(url:string,options:{method:string;headers:Record<string,string>})=>Promise<ResponseLike>;
/** Réponse authentifiée par session ; à utiliser uniquement après vérification
 * du certificat HTTPS et avec une session commerciale non expirée. */
export async function fetchServerLineage(session:CommercialSession,request:Request,allowPrivateHttp=false):Promise<LineagePin>{
 const origin=apiOrigin(session.serverOrigin);
 if(origin!==session.serverOrigin||(!origin.startsWith('https://')&&!(allowPrivateHttp&&isPrivateHttpOrigin(origin)))||!uuid(session.id)||!session.token||!Number.isFinite(Date.parse(session.expiresAt))||Date.parse(session.expiresAt)<=Date.now())throw Error('Session HTTPS valide requise.');
 const response=await request(`${origin}/api/mobile/identified/server-lineage`,{method:'GET',headers:{Authorization:`Bearer ${session.token}`}});
 if(!response.ok)throw Error(`Identité serveur indisponible (${response.status}).`);
 const value=await response.json().catch(()=>null) as {version?:unknown;commercialId?:unknown;lineageId?:unknown}|null;
 if(!value||value.version!==1||value.commercialId!==session.id||!uuid(value.lineageId))throw Error('Identité serveur invalide.');
 return {commercialId:session.id,serverOrigin:origin,lineageId:value.lineageId};
}
/** Vérification nécessaire mais insuffisante : ne prouve ni l'unicité de la
 * copie, ni l'absence de restauration ancienne, ni l'autorisation du transfert. */
export function compareLineagePins(bound:DeviceIdentity,pinned:LineagePin|null,candidate:LineagePin):void{
 if(!pinned||!uuid(pinned.lineageId)||!uuid(candidate.lineageId)||!uuid(bound.commercialId)||pinned.commercialId!==bound.commercialId||pinned.serverOrigin!==bound.serverOrigin||candidate.commercialId!==bound.commercialId||pinned.lineageId!==candidate.lineageId||candidate.serverOrigin===bound.serverOrigin||apiOrigin(candidate.serverOrigin)!==candidate.serverOrigin||!candidate.serverOrigin.startsWith('https://'))throw Error('Lignée non confirmée : rapprochement nécessaire.');
}
