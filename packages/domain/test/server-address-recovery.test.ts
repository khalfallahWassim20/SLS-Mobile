import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {issueAddressApproval,redeemAddressApproval} from '../../../apps/api/src/mobile-address-approval.js';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {creditSourcesPrototypeSchema} from '../../../apps/mobile/credit-note-sources-prototype.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {recoverAddressPrototype} from '../../../apps/mobile/server-address-recovery-prototype.js';

test('essai fictif complet : approbation, comparaison et migration, sans envoi d’opérations',async()=>{
 const db=new PGlite(),phone=new DatabaseSync(':memory:');try{
  await db.exec(schemaSql);const connection={query:(sql:string,args?:unknown[])=>db.query(sql,args),release:()=>{}};const pool={query:connection.query,connect:async()=>connection} as unknown as Pool;
  const person=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});assert.ok(person);await setCommercialCredentials(pool,'admin',person.id,{login:'recovery.test',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour les tests',login=await loginCommercial(pool,secret,{login:'recovery.test',password:'mot de passe fictif'});assert.ok(login);
  const lineageId=(await db.query<{id:string}>('SELECT lineage_id::text AS id FROM server_lineage_identity')).rows[0].id;
  const old={commercialId:person.id,serverOrigin:'http://192.168.43.101:3001'},target='https://api.example.test',session={id:person.id,name:person.name,serverOrigin:target,token:login.token,expiresAt:login.expiresAt};
  phone.exec(`${identifiedDeviceSchema}${creditReferencePrototypeSchema}${creditSourcesPrototypeSchema}${offlineCreditPrototypeSchema} CREATE TABLE sales_outbox(operation_id TEXT,payload TEXT);`);
  phone.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(person.id,old.serverOrigin);phone.prepare('INSERT INTO sales_outbox VALUES(?,?)').run('pending','{"facture":1}');
  const client=randomUUID(),sale=randomUUID();const reference={version:4,clients:[{id:client,name:'Test',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'0'}],articles:[],saleStates:[{saleId:sale,clientId:client,version:1,total:'1000',paid:'500'}],settlementStates:[],journalStates:[],journalProofs:[]};
  phone.prepare('INSERT INTO identified_reference_cache VALUES(1,?,?,?)').run(person.id,old.serverOrigin,JSON.stringify(reference));
  const requestId=randomUUID(),details={requestId,commercialId:person.id,previousOrigin:old.serverOrigin,targetOrigin:target,lineageId};
  const approval=await issueAddressApproval(pool,'admin',{...details,confirmation:'J_AI_VERIFIE_LA_BASE_ET_LE_TELEPHONE'});
  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>phone.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>phone.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{phone.prepare(sql).run(...args)}};
  const transaction=async<T>(fn:(context:typeof tx)=>Promise<T>)=>{phone.exec('BEGIN');try{const result=await fn(tx);phone.exec('COMMIT');return result;}catch(e){phone.exec('ROLLBACK');throw e;}};
  const seen:string[]=[];let corrupt=false,expire=false;
  const request=async(url:string,options:{method:string;headers:Record<string,string>;body?:string})=>{seen.push(url);assert.ok(url.startsWith(target));
   if(url.endsWith('/server-lineage'))return {ok:true,status:200,json:async()=>({version:1,commercialId:person.id,lineageId})};
   if(url.endsWith('/reference'))return {ok:true,status:200,json:async()=>corrupt?{...reference,saleStates:[]}:reference};
   if(url.endsWith('/redeem')){try{const data=await redeemAddressApproval(pool,secret,options.headers.Authorization.slice(7),JSON.parse(options.body!));return {ok:true,status:200,json:async()=>expire?{...data,expiresAt:new Date(Date.now()-1).toISOString()}:data};}catch{return {ok:false,status:409,json:async()=>({})};}}
   throw Error('Envoi de données interdit dans ce test.');};
  const io={testOnly:'DONNEES_FICTIVES_ISOLEES' as const,request,transaction,digest:async(s:string)=>createHash('sha256').update(s).digest('hex'),isCurrent:()=>true};
  corrupt=true;await assert.rejects(recoverAddressPrototype(old,session,requestId,approval.code,4,io),/vente/);assert.ok(!seen.some(u=>u.endsWith('/redeem')));corrupt=false;
  expire=true;await assert.rejects(recoverAddressPrototype(old,session,requestId,approval.code,4,io),/invalide/);assert.equal(phone.prepare('SELECT server_origin FROM identified_device').get()?.server_origin,old.serverOrigin);expire=false;
  // Une interruption juste après l'écriture de l'identité annule aussi les caches.
  let current=true;
  const failingTransaction=async<T>(fn:(context:typeof tx)=>Promise<T>)=>transaction(async context=>fn({...context,runAsync:async(sql:string,...args:(string|number|null)[])=>{await context.runAsync(sql,...args);if(sql.startsWith('UPDATE identified_device SET'))current=false;}}));
  await assert.rejects(recoverAddressPrototype(old,session,requestId,approval.code,4,{...io,transaction:failingTransaction,isCurrent:()=>current}),/contexte modifié/);
  assert.equal(phone.prepare('SELECT server_origin FROM identified_device').get()?.server_origin,old.serverOrigin);
  assert.equal(phone.prepare('SELECT server_origin FROM identified_reference_cache').get()?.server_origin,old.serverOrigin);
  assert.equal(phone.prepare('SELECT payload FROM sales_outbox').get()?.payload,'{"facture":1}');
  const result=await recoverAddressPrototype(old,session,requestId,approval.code,4,io);assert.equal(result.requiresReconnect,true);assert.equal(result.anchors,1);
  assert.equal(phone.prepare('SELECT server_origin FROM identified_device').get()?.server_origin,target);assert.equal(phone.prepare('SELECT payload FROM sales_outbox').get()?.payload,'{"facture":1}');
  assert.ok(seen.every(u=>/server-lineage$|reference$|redeem$/.test(u)));
 }finally{phone.close();await db.close();}
});
