/** Parcours expérimental non relié aux écrans. Ce contrôleur n'autorise pas
 * la production : l'aval humain et la comparaison d'historiques ne prouvent
 * pas qu'une copie ou restauration divergente est la base d'origine. */
import type {DeviceIdentity} from './identified-device';
import type {CommercialSession} from './commercial-login';
import {isPrivateHttpOrigin} from './private-api-origin';
import {validSession} from './secure-commercial-session';
import {fetchServerLineage} from './server-lineage-proof';
import {inspectAddressContinuity} from './server-address-continuity';
import {migrateDeviceOriginPrototype} from './server-address-migration';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
type Request=(url:string,options:{method:string;headers:Record<string,string>;body?:string})=>Promise<Response>;
type IO={testOnly?:'DONNEES_FICTIVES_ISOLEES';allowPrivateHttp?:boolean;request:Request;transaction:<T>(fn:(tx:Tx)=>Promise<T>)=>Promise<T>;digest:(s:string)=>Promise<string>;now?:()=>number;isCurrent:()=>boolean};
export type AddressRecoveryRequest={requestId:string;commercialId:string;previousOrigin:string;targetOrigin:string;lineageId:string};
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
let busy=false;
/** S'arrête après migration locale : ne synchronise aucune opération. L'UI
 * future doit suspendre toutes les écritures et synchronisations concurrentes,
 * effacer l'ancienne session et demander une nouvelle connexion. */
export async function recoverAddressPrototype(old:DeviceIdentity,session:CommercialSession,requestId:string,code:string,version:4|5,io:IO){
 if(busy)throw Error('Rapprochement déjà en cours.');busy=true;
 const now=io.now??Date.now,newIdentity={commercialId:session.id,serverOrigin:session.serverOrigin};
 const check=()=>{if(!io.isCurrent()||!validSession(session,newIdentity,now())||(!session.serverOrigin.startsWith('https://')&&!(io.allowPrivateHttp&&isPrivateHttpOrigin(session.serverOrigin)))||old.commercialId!==session.id)throw Error('Session HTTPS expirée ou contexte modifié : rapprochement annulé.');};
 try{
  if(io.testOnly!=='DONNEES_FICTIVES_ISOLEES'&&!io.allowPrivateHttp)throw Error('Mode de rapprochement non autorisé.');
  check();if(!uuid(requestId)||!/^[A-Za-z0-9_-]{43}$/.test(code)||old.serverOrigin===session.serverOrigin)throw Error('Demande ou code invalide.');
  const candidate=await fetchServerLineage(session,io.request,io.allowPrivateHttp);check();
  const request:AddressRecoveryRequest={requestId,commercialId:old.commercialId,previousOrigin:old.serverOrigin,targetOrigin:session.serverOrigin,lineageId:candidate.lineageId};
  const referenceResponse=await io.request(`${session.serverOrigin}/api/mobile/identified/reference`,{method:'GET',headers:{Authorization:`Bearer ${session.token}`,...(version===5?{'X-SLS-Reference-Version':'5'}:{})}});check();
  if(!referenceResponse.ok)throw Error('Référence candidate indisponible.');
  const reference=await referenceResponse.json();check();
  // Le serveur est vérifié avant l'échange du code ; aucun cache ne change.
  const comparison=await io.transaction(tx=>inspectAddressContinuity(tx,old,version,reference,io.digest));check();
  const authorization=await io.request(`${session.serverOrigin}/api/mobile/address-approvals/redeem`,{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},body:JSON.stringify({...request,code})});check();
  if(!authorization.ok)throw Error('Autorisation administrative refusée ou expirée.');
  const grant=await authorization.json() as Record<string,unknown>;check();
  const deadline=typeof grant?.expiresAt==='string'?Date.parse(grant.expiresAt):NaN;
  if(!grant||grant.requestId!==requestId||grant.commercialId!==old.commercialId||grant.previousOrigin!==old.serverOrigin||grant.targetOrigin!==session.serverOrigin||grant.lineageId!==candidate.lineageId||typeof grant.replay!=='boolean'||!Number.isFinite(deadline)||deadline<=now()||deadline-now()>5*60*1000)throw Error('Autorisation administrative invalide.');
  await io.transaction(async tx=>{
   check();if(deadline<=now())throw Error('Autorisation expirée.');
   const fresh=await inspectAddressContinuity(tx,old,version,reference,io.digest);check();
   if(fresh.anchors!==comparison.anchors||deadline<=now())throw Error('Référence ou autorisation modifiée.');
   await migrateDeviceOriginPrototype(tx,old,session.serverOrigin);check();
   if(deadline<=now())throw Error('Autorisation expirée.');
  });
  return {status:'address-migrated' as const,commercialId:old.commercialId,serverOrigin:session.serverOrigin,anchors:comparison.anchors,requiresReconnect:true as const};
 }finally{busy=false;}
}
