/** Connexion du banc fictif uniquement : aucune migration de téléphone réel. */
import {apiOrigin,openBoundCommercialSession,type CommercialSession} from './commercial-login';
import {validSession} from './secure-commercial-session';
import {isPrivateHttpOrigin} from './private-api-origin';
import {fetchServerLineage,type LineagePin} from './server-lineage-proof';
import {createDayInvoiceTransportPrototype} from './day-invoice-transport';
import {assertIsolatedDayInvoicePin,type IsolatedSetup} from './day-invoice-isolated-setup';
import type {DeviceIdentity} from './identified-device';
type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
type Request=(url:string,options:{method:string;headers:Record<string,string>;body?:string})=>Promise<Response>;
type IO={request:Request;readIdentity:()=>Promise<DeviceIdentity|null>;readSetup:()=>Promise<IsolatedSetup|null>;initialize:(identity:DeviceIdentity,pin:LineagePin,name:string,reference:unknown,check:()=>void)=>Promise<IsolatedSetup>;isCurrent:()=>boolean};
export async function connectIsolatedDayInvoice(address:string,login:string,password:string,io:IO){
 const check=()=>{if(!io.isCurrent())throw Error('Connexion interrompue.');};
 check();const origin=apiOrigin(address);
 // Le contrôle doit précéder le login : sinon le mot de passe serait transmis
 // en clair avant le refus du transport de référence ou de lignée.
 if(!origin.startsWith('https://')&&!isPrivateHttpOrigin(origin))throw Error('Adresse refusée : HTTPS ou IP privée requis. Aucun mot de passe envoyé.');
 const next=await openBoundCommercialSession(origin,login,password,io.request,io.readIdentity);check();
 const identity={commercialId:next.id,serverOrigin:next.serverOrigin};
 const checkSession=()=>{check();if(!validSession(next,identity))throw Error('Session expirée ou horloge incorrecte.');};checkSession();
 const pin=await fetchServerLineage(next,io.request,true);checkSession();let setup=await io.readSetup();checkSession();
 if(setup)assertIsolatedDayInvoicePin(setup,pin);
 else {
  const transport=createDayInvoiceTransportPrototype(next,identity,pin,{request:io.request,isCurrentSession:io.isCurrent,allowPrivateHttp:true});
  await transport.verifyServer(identity,checkSession);checkSession();const reference=await transport.fetchReference();checkSession();
  setup=await io.initialize(identity,pin,next.name,reference,checkSession);checkSession();
 }
 return {session:next as CommercialSession,setup};
}
