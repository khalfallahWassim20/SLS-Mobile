/** Serveur HTTPS et PostgreSQL jetables ; aucune donnée ou certificat réel. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {recoverAddressPrototype} from '../../mobile/server-address-recovery-prototype.js';
import {identifiedDeviceSchema} from '../../mobile/identified-device.js';
import {offlineCreditPrototypeSchema} from '../../mobile/credit-note-offline-prototype.js';
import {creditReferencePrototypeSchema} from '../../mobile/credit-note-reference-cache-prototype.js';
import {creditSourcesPrototypeSchema} from '../../mobile/credit-note-sources-prototype.js';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';

test('serveur HTTPS isolé : circuit des autorisations authentifié',async()=>{
 const database=process.env.DATABASE_URL;if(!database)throw Error('DATABASE_URL manquante');
 const dir=mkdtempSync(join(tmpdir(),'sls-tls-')),key=join(dir,'key.pem'),cert=join(dir,'cert.pem');let child:ChildProcess|undefined,pool:pg.Pool|undefined;
 const schema='sls_tls_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:database}),secret='secret fictif assez long pour les essais TLS';
 try{
  const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1,DNS:api.example.test'],{stdio:'ignore'});assert.equal(generated.status,0,'openssl requis pour le test TLS');
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema}`});await pool.query(schemaSql);
  const person=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});await setCommercialCredentials(pool,'admin',person.id,{login:'tls.test',password:'mot de passe fictif'});
  const lineageId=(await pool.query('SELECT lineage_id::text AS id FROM server_lineage_identity')).rows[0].id;
  const port=await new Promise<number>((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string')return reject(Error('port'));s.close(()=>resolve(a.port));});});
  const env={...process.env,DATABASE_URL:database,PGOPTIONS:`-c search_path=${schema}`,PORT:String(port),API_HOST:'127.0.0.1',JWT_SECRET:secret,ADMIN_USERNAME:'testadmin',ADMIN_PASSWORD_HASH:bcrypt.hashSync('mot de passe fictif',4),SLS_V5_TEST_ONLY:'DONNEES_FICTIVES_ISOLEES',SLS_ADDRESS_TEST_ONLY:'DONNEES_FICTIVES_ISOLEES',SLS_ADDRESS_TEST_TLS_KEY:key,SLS_ADDRESS_TEST_TLS_CERT:cert};
  child=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env,stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Serveur TLS non démarré')),15000);child!.stdout!.on('data',d=>{if(String(d).includes('API de développement prête')){clearTimeout(timer);resolve();}});child!.once('exit',c=>{clearTimeout(timer);reject(Error(`Serveur arrêté ${c}`));});child!.stderr!.on('data',d=>process.stderr.write(d));});
  const post=(path:string,data:unknown,token?:string)=>new Promise<{status:number;body:any;cache:string|undefined}>((resolve,reject)=>{const req=httpsRequest({hostname:'127.0.0.1',port,path:'/api'+path,method:'POST',ca:readFileSync(cert),headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})}},res=>{let raw='';res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode??0,body:raw?JSON.parse(raw):null,cache:res.headers['cache-control']}));});req.on('error',reject);req.end(JSON.stringify(data));});
  const admin=await post('/login',{username:'testadmin',password:'mot de passe fictif'});assert.equal(admin.status,200);
  const mobile=await post('/mobile/session/login',{login:'tls.test',password:'mot de passe fictif'});assert.equal(mobile.status,200);
  const input={requestId:randomUUID(),commercialId:person.id,previousOrigin:'http://192.168.43.101:3001',targetOrigin:`https://api.example.test:${port}`,lineageId};
  assert.equal((await post('/address-approvals',{...input,confirmation:'J_AI_VERIFIE_LA_BASE_ET_LE_TELEPHONE'})).status,401);
  const approval=await post('/address-approvals',{...input,confirmation:'J_AI_VERIFIE_LA_BASE_ET_LE_TELEPHONE'},admin.body.token);assert.equal(approval.status,201);assert.equal(approval.cache,'no-store');
  assert.equal((await post('/mobile/address-approvals/redeem',{...input,code:approval.body.code},'invalide')).status,409);
  const redeemed=await post('/mobile/address-approvals/redeem',{...input,code:approval.body.code},mobile.body.token);assert.equal(redeemed.status,200);assert.equal(redeemed.body.requestId,input.requestId);
  assert.equal((await post(`/address-approvals/${input.requestId}/revoke`,{},admin.body.token)).status,200);
  assert.equal((await post('/mobile/address-approvals/redeem',{...input,code:approval.body.code},mobile.body.token)).status,409);
  // De bout en bout sur HTTPS réel : un cache local v4 antérieur et une file
  // sont conservés, aucun envoi n'est déclenché par le changement lui-même.
  await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const clientId=randomUUID();await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Client fictif']);
  const now=new Date().toISOString(),saleId=randomUUID(),sale={createdAt:now,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  const saleResponse=await post('/mobile/identified/sales',{operationId:randomUUID(),saleId,version:1,recordedAt:now,sale,refund:0},mobile.body.token);assert.equal(saleResponse.status,201);
  const network=async(url:string,options:{method:string;headers:Record<string,string>;body?:string})=>{
   const parsed=new URL(url);assert.equal(parsed.origin,input.targetOrigin);
   return new Promise<{ok:boolean;status:number;json:()=>Promise<unknown>}>((resolve,reject)=>{
    const req=httpsRequest({hostname:'127.0.0.1',servername:'api.example.test',port,path:parsed.pathname,method:options.method,headers:options.headers,ca:readFileSync(cert)},res=>{let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>{const status=res.statusCode??0;resolve({ok:status>=200&&status<300,status,json:async()=>JSON.parse(raw)});});});req.on('error',reject);req.end(options.body);
   });
  };
  const refResponse=await network(input.targetOrigin+'/api/mobile/identified/reference',{method:'GET',headers:{Authorization:`Bearer ${mobile.body.token}`}});assert.equal(refResponse.status,200);const reference=await refResponse.json();
  const phone=new DatabaseSync(':memory:');try{
   phone.exec(`${identifiedDeviceSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}${creditSourcesPrototypeSchema} CREATE TABLE sales_outbox(operation_id TEXT,payload TEXT);`);
   phone.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(person.id,input.previousOrigin);phone.prepare('INSERT INTO identified_reference_cache VALUES(1,?,?,?)').run(person.id,input.previousOrigin,JSON.stringify(reference));phone.prepare('INSERT INTO sales_outbox VALUES(?,?)').run(randomUUID(),'{"operation":"conserver"}');
   const newInput={...input,requestId:randomUUID()},approved=await post('/address-approvals',{...newInput,confirmation:'J_AI_VERIFIE_LA_BASE_ET_LE_TELEPHONE'},admin.body.token);assert.equal(approved.status,201);
   const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>phone.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>phone.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{phone.prepare(sql).run(...args)}};
   const transaction=async<T>(fn:(context:typeof tx)=>Promise<T>)=>{phone.exec('BEGIN');try{const result=await fn(tx);phone.exec('COMMIT');return result;}catch(e){phone.exec('ROLLBACK');throw e;}};
   const old={commercialId:person.id,serverOrigin:input.previousOrigin},session={id:person.id,name:person.name,serverOrigin:input.targetOrigin,token:mobile.body.token,expiresAt:mobile.body.expiresAt};
   const result=await recoverAddressPrototype(old,session,newInput.requestId,approved.body.code,4,{testOnly:'DONNEES_FICTIVES_ISOLEES',request:network,transaction,isCurrent:()=>true,digest:async(s:string)=>createHash('sha256').update(s).digest('hex')});
   assert.equal(result.requiresReconnect,true);assert.equal(phone.prepare('SELECT server_origin FROM identified_device').get()?.server_origin,input.targetOrigin);assert.equal(phone.prepare('SELECT payload FROM sales_outbox').get()?.payload,'{"operation":"conserver"}');
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_sale_events')).rows[0].n,1);
  }finally{phone.close();}

 }finally{
  if(child&&child.exitCode===null)await new Promise<void>(resolve=>{child!.once('exit',()=>resolve());child!.kill('SIGTERM');});
  if(pool)await pool.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();rmSync(dir,{recursive:true,force:true});
 }
});
