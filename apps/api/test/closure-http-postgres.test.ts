/** Parcours réseau du serveur réel sur un schéma PostgreSQL temporaire. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import {schemaSql} from '../src/schema.js';

test('HTTP réel PostgreSQL : bascule, ventes, clôture et réouverture admin',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante.');
 const schema='sls_http_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});
 const port=await new Promise<number>((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string')return reject(Error('Port indisponible'));s.close(()=>resolve(a.port));});});
 let server:ReturnType<typeof spawn>|undefined,created=false,logs='';
 try {
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;
  const isolated=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});try{await isolated.query(schemaSql);}finally{await isolated.end();}
  const pass='mot de passe fictif',hash=await bcrypt.hash(pass,4);
  server=spawn(process.execPath,['--import','tsx','apps/api/src/server.ts'],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:url,PGOPTIONS:`-c search_path=${schema}`,PORT:String(port),API_HOST:'127.0.0.1',JWT_SECRET:'secret fictif suffisamment long pour les tests',ADMIN_USERNAME:'admin',ADMIN_PASSWORD_HASH:hash,MOBILE_DEMO_TOKEN:'jeton-partage-fictif-superieur-a-32-caracteres'}});
  server.stdout?.on('data',d=>{logs+=d.toString()});server.stderr?.on('data',d=>{logs+=d.toString()});
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Serveur indisponible : '+logs)),15000);server!.once('exit',code=>{clearTimeout(timeout);reject(Error('Serveur arrêté '+code+' : '+logs))});server!.stdout!.on('data',()=>{if(logs.includes('API de développement prête')){clearTimeout(timeout);resolve()}})});
  const base=`http://127.0.0.1:${port}`;
  const request=async(path:string,method='GET',body?:unknown,token?:string)=>{
   const response=await fetch(base+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
   return {status:response.status,body:await response.json() as any};
  };
  const adminLogin=await request('/api/login','POST',{username:'admin',password:pass});assert.equal(adminLogin.status,200);const admin=adminLogin.body.token;
  const commercial=(await request('/api/commercials','POST',{name:'Commercial fictif',active:true},admin)).body;
  assert.equal((await request(`/api/commercials/${commercial.id}/credentials`,'PUT',{login:'commercial.test',password:pass},admin)).status,200);
  const client=await request('/api/clients','POST',{name:'Client fictif',sector:'',address:'',taxId:'',phone:'',openingBalance:1000000,creditLimit:0,active:true},admin);assert.equal(client.status,201);
  const login=await request('/api/mobile/session/login','POST',{login:'commercial.test',password:pass});assert.equal(login.status,200);const token=login.body.token;
  assert.equal((await request('/api/mobile/identified/reference','GET',undefined,token)).status,409);
  assert.equal((await request('/api/tour-sync-mode/activate','POST',{confirmation:'TOUS LES APPAREILS SONT SYNCHRONISÉS'},token)).status,401);
  assert.equal((await request('/api/tour-sync-mode/activate','POST',{confirmation:'TOUS LES APPAREILS SONT SYNCHRONISÉS'},admin)).status,200);
  const day='2026-11-10',at='2026-11-10T08:00:00.000Z',invoiceId=randomUUID();
  const invoice={id:invoiceId,clientId:client.body.id,clientName:'Client fictif',journalDate:day,createdAt:at,sector:'',amount:600000};
  const first={operationId:randomUUID(),version:1,invoice,receipts:[]};
  assert.equal((await request('/api/mobile/identified/journal','POST',first,token)).status,201);
  const receipt={id:randomUUID(),preInvoiceId:invoiceId,clientId:client.body.id,journalDate:day,createdAt:at,prePaid:200000,oldDebtPaid:300000,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1000000};
  const payment={operationId:randomUUID(),version:2,invoice,receipts:[receipt]};
  assert.equal((await request('/api/mobile/identified/journal','POST',payment,token)).status,201);
  const saleId=randomUUID(),saleOp=randomUUID(),sale={createdAt:at,clientId:client.body.id,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:210084,discount:0,vat:1900}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  assert.equal((await request('/api/mobile/identified/sales','POST',{operationId:saleOp,saleId,version:1,recordedAt:at,sale,refund:0},token)).status,201);
  const ref=await request('/api/mobile/identified/reference','GET',undefined,token);assert.equal(ref.status,200);assert.equal(ref.body.clients[0].serverBalance,'1350000');
  const dashboard=await request(`/api/demo-tour-journal/${day}`,'GET',undefined,admin);assert.equal(dashboard.status,200);assert.equal(dashboard.body.rows[0].totalClient,850000);
  assert.equal((await request('/api/demo-balances','GET',undefined,admin)).body[0].balance,'1350000');
  const close={requestId:randomUUID(),day,expectedVersion:0};
  assert.equal((await request('/api/mobile/identified/close','POST',close,token)).status,201);
  assert.equal((await request('/api/mobile/identified/close','POST',close,token)).body.status,'duplicate');
  const next={...payment,operationId:randomUUID(),version:3,receipts:[receipt,{...receipt,id:randomUUID(),prePaid:10000,oldDebtPaid:0}]};
  assert.equal((await request('/api/mobile/identified/journal','POST',next,token)).status,409);
  assert.equal((await request('/api/mobile/identified/sales','POST',{operationId:saleOp,saleId,version:1,recordedAt:at,sale,refund:0},token)).body.status,'duplicate');
  const nextSale={operationId:randomUUID(),saleId,version:2,recordedAt:at,sale:{...sale,syncVersion:2},refund:0};
  assert.equal((await request('/api/mobile/identified/sales','POST',nextSale,token)).status,409);
  const payId=randomUUID(),settlement={operationId:payId,settlement:{syncOperationId:payId,createdAt:at,clientId:client.body.id,clientName:'Client fictif',amount:1000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}};
  assert.equal((await request('/api/mobile/identified/settlements','POST',settlement,token)).status,409);
  assert.equal((await request('/api/mobile/sales','POST',{operationId:randomUUID(),saleId:randomUUID(),version:1,sale:{...sale,syncSaleId:randomUUID()},refund:0},'jeton-partage-fictif-superieur-a-32-caracteres')).status,400);
  const legacyId=randomUUID();
  assert.equal((await request('/api/mobile/sales','POST',{operationId:randomUUID(),saleId:legacyId,version:1,sale:{...sale,syncSaleId:legacyId},refund:0},'jeton-partage-fictif-superieur-a-32-caracteres')).status,409);
  const reopen={requestId:randomUUID(),day,expectedVersion:1};
  assert.equal((await request(`/api/identified-tour-actions/${commercial.id}/reopen`,'POST',reopen,token)).status,401);
  assert.equal((await request(`/api/identified-tour-actions/${commercial.id}/reopen`,'POST',reopen,admin)).status,201);
  assert.equal((await request('/api/mobile/identified/journal','POST',next,token)).status,201);
  assert.equal((await request('/api/mobile/identified/sales','POST',nextSale,token)).status,201);
  assert.equal((await request('/api/mobile/identified/settlements','POST',settlement,token)).status,201);
 } finally {
  if(server && server.exitCode===null){server.kill('SIGTERM');await new Promise<void>(resolve=>server!.once('exit',()=>resolve()));}
  if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();
 }
});
