import {apiOrigin,type CommercialSession} from './commercial-login.ts';
export type SecureStore={getItemAsync:(key:string)=>Promise<string|null>;setItemAsync:(key:string,value:string)=>Promise<void>;deleteItemAsync:(key:string)=>Promise<void>};
export type BoundIdentity={commercialId:string;serverOrigin:string};
const KEY='sls_commercial_session_v1';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validSession(value:unknown,identity:BoundIdentity|null,now=Date.now()):value is CommercialSession {
 if(!value||typeof value!=='object'||!identity||!Number.isFinite(now))return false;
 const s=value as Record<string,unknown>;
 if(typeof s.id!=='string'||!UUID.test(s.id)||s.id!==identity.commercialId||typeof s.name!=='string'||!s.name.trim()||s.name.length>200||typeof s.token!=='string'||!s.token||s.token.length>8192||typeof s.serverOrigin!=='string'||s.serverOrigin!==identity.serverOrigin||typeof s.expiresAt!=='string')return false;
 try {if(apiOrigin(s.serverOrigin)!==s.serverOrigin)return false;const expiry=Date.parse(s.expiresAt);return Number.isFinite(expiry)&&new Date(expiry).toISOString()===s.expiresAt&&expiry>now&&expiry-now<=26*60*60*1000;}catch{return false;}
}
/** Sérialise les accès afin qu'une suppression ancienne ne puisse effacer une nouvelle session. */
export function createSecureSessionStore(store:SecureStore) {
 let queue:Promise<unknown>=Promise.resolve();
 const run=<T>(fn:()=>Promise<T>):Promise<T>=>{const result=queue.then(fn,fn);queue=result.catch(()=>{});return result;};
 return {
  save:(session:CommercialSession)=>run(()=>store.setItemAsync(KEY,JSON.stringify(session))),
  restore:(identity:BoundIdentity|null,now=Date.now())=>run(async()=>{const raw=await store.getItemAsync(KEY);if(!raw)return null;let value:unknown;try{value=JSON.parse(raw)}catch{value=null;}if(!validSession(value,identity,now)){await store.deleteItemAsync(KEY);return null;}return value;}),
  clear:()=>run(()=>store.deleteItemAsync(KEY)),
  clearIfToken:(token:string)=>run(async()=>{const raw=await store.getItemAsync(KEY);if(!raw)return;try{const value=JSON.parse(raw);if(value?.token===token)await store.deleteItemAsync(KEY);}catch{await store.deleteItemAsync(KEY);}}),
 };
}
