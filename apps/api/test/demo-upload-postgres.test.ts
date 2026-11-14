import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import {schemaSql} from '../src/schema.js';
import {uploadDemoQueue,type DemoQueueEntry} from '../../mobile/demo-upload.js';

test('HTTP réel : accusés démo identifiés, réponse perdue et reprise sans double écriture',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const schema='sls_demo_ack_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let server:ReturnType<typeof spawn>|undefined,created=false,logs='';
 const port=await new Promise<number>((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string')return reject(Error('Port indisponible'));s.close(()=>resolve(a.port));});});
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;
  const isolated=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});try{await isolated.query(schemaSql);}finally{await isolated.end();}
  const token='jeton-partage-fictif-superieur-a-32-caracteres',password='mot de passe fictif',hash=await bcrypt.hash(password,4);
  server=spawn(process.execPath,['--import','tsx','apps/api/src/server.ts'],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:url,PGOPTIONS:`-c search_path=${schema}`,PORT:String(port),API_HOST:'127.0.0.1',JWT_SECRET:'secret fictif suffisamment long pour les tests',ADMIN_USERNAME:'admin',ADMIN_PASSWORD_HASH:hash,MOBILE_DEMO_TOKEN:token}});
  server.stdout?.on('data',d=>{logs+=d.toString()});server.stderr?.on('data',d=>{logs+=d.toString()});
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Serveur indisponible : '+logs)),15000);server!.once('exit',code=>{clearTimeout(timeout);reject(Error('Serveur arrêté '+code+' : '+logs))});server!.stdout!.on('data',()=>{if(logs.includes('API de développement prête')){clearTimeout(timeout);resolve()}})});
  const base=`http://127.0.0.1:${port}`;
  const request=(path:string,body:unknown,auth?:string)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth}:{})},body:JSON.stringify(body)});
  const login=await request('/api/login',{username:'admin',password});assert.equal(login.status,200);const admin=(await login.json() as {token:string}).token;
  const clientResponse=await request('/api/clients',{name:'Client fictif',sector:'',address:'',taxId:'',phone:'',openingBalance:0,creditLimit:0,active:true},admin);assert.equal(clientResponse.status,201);const clientId=(await clientResponse.json() as {id:string}).id;
  const saleId=randomUUID(),saleOp=randomUUID(),payId=randomUUID(),at='2026-11-10T08:00:00.000Z';
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:210084,discount:0,vat:1900}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  const event={operationId:saleOp,saleId,version:1,sale,refund:0},payment={operationId:payId,settlement:{syncOperationId:payId,createdAt:at,clientId,clientName:'Client fictif',amount:1000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}};
  const entries:DemoQueueEntry[]=[{sequence:1,operationId:saleOp,saleId,version:1,payload:JSON.stringify(event),lastError:null},{sequence:2,operationId:payId,saleId:payId,version:1,payload:JSON.stringify(payment),lastError:null}];
  const paths:string[]=[],acks:string[]=[];let lose=true;
  const send=async(path:'sales'|'settlements',entry:DemoQueueEntry)=>{paths.push(path);const response=await fetch(`${base}/api/mobile/${path}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:entry.payload});if(lose){lose=false;assert.equal(response.status,201);assert.deepEqual(await response.json(),{status:'reçue',operationId:saleOp});throw Error('réponse perdue');}return response;};
  await assert.rejects(uploadDemoQueue(entries,send,async e=>{acks.push(e.operationId)}),/réponse perdue/);assert.deepEqual(acks,[]);
  assert.equal(await uploadDemoQueue(entries,send,async e=>{acks.push(e.operationId)}),2);assert.deepEqual(acks,[saleOp,payId]);assert.deepEqual(paths,['sales','sales','settlements']);
  const duplicate=await request('/api/mobile/settlements',payment,token);assert.equal(duplicate.status,200);assert.deepEqual(await duplicate.json(),{status:'déjà reçue',operationId:payId});
  assert.equal((await request('/api/mobile/settlements',{...payment,settlement:{...payment.settlement,amount:2000}},token)).status,409);
  const read=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});try{assert.equal(Number((await read.query('SELECT count(*) n FROM demo_sale_events')).rows[0].n),1);assert.equal(Number((await read.query('SELECT count(*) n FROM demo_settlements')).rows[0].n),1);}finally{await read.end();}
 }finally{if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise<void>(resolve=>server!.once('exit',()=>resolve()));}if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
