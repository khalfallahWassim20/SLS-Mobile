/** Le vrai serveur reste v3 par défaut ; la bascule de test seule monte v5. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';

test('serveur réel : v5 uniquement sur option de test, authentification et avoir',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_v5_server_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,child:ChildProcess|undefined;
 const secret='secret fictif pour test serveur 123456789',cwd=fileURLToPath(new URL('..',import.meta.url));
 const start=async(enabled:boolean)=>{
  const port=await new Promise<number>((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string')return reject(Error('port'));s.close(()=>resolve(a.port));});});
  const env={...process.env,DATABASE_URL:url,PGOPTIONS:`-c search_path=${schema}`,PORT:String(port),API_HOST:'127.0.0.1',JWT_SECRET:secret,ADMIN_USERNAME:'testadmin',ADMIN_PASSWORD_HASH:bcrypt.hashSync('password-fictif',4),SLS_V5_TEST_ONLY:enabled?'DONNEES_FICTIVES_ISOLEES':''};
  child=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd,env,stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Serveur de test non démarré')),15000);child!.stdout!.on('data',data=>{if(String(data).includes('API de développement prête')){clearTimeout(timer);resolve();}});child!.once('exit',code=>{clearTimeout(timer);reject(Error(`Serveur arrêté ${code}`));});child!.stderr!.on('data',data=>process.stderr.write(data));});
  return `http://127.0.0.1:${port}/api`;
 };
 const stop=async()=>{const c=child;child=undefined;if(!c||c.exitCode!==null)return;await new Promise<void>(resolve=>{c.once('exit',()=>resolve());c.kill('SIGTERM');});};
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const commercial=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});await setCommercialCredentials(pool,'admin',commercial.id,{login:'v5.server',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'v5.server',password:'mot de passe fictif'});assert.ok(session);
  const clientId=randomUUID();await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,1000000)',[clientId,'Client fictif']);
  let base=await start(false);
  const auth={Authorization:`Bearer ${session.token}`,'X-SLS-Reference-Version':'5'};
  let response=await fetch(`${base}/mobile/identified/reference`,{headers:auth});assert.equal(response.status,200);assert.notEqual((await response.json()).version,5);
  response=await fetch(`${base}/mobile/identified/credit-notes/sales`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,401);await stop();
  base=await start(true);
  response=await fetch(`${base}/mobile/identified/reference`,{headers:auth});assert.equal(response.status,200);assert.equal((await response.json()).version,5);
  response=await fetch(`${base}/identified-tour/credit-snapshot`,{headers:{'X-SLS-Reference-Version':'5'}});assert.equal(response.status,401);
  const login=await fetch(`${base}/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'testadmin',password:'password-fictif'})});assert.equal(login.status,200);const admin=(await login.json()).token;
  const adminHeaders={Authorization:`Bearer ${admin}`,'Content-Type':'application/json','X-SLS-Reference-Version':'5'};
  const at=new Date().toISOString(),saleId=randomUUID(),sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  response=await fetch(`${base}/mobile/identified/sales`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0})});assert.equal(response.status,201);
  const revised={...sale,syncVersion:2,lines:[{...sale.lines[0],unitPrice:10000}],total:11900,paid:11900,remaining:0};
  response=await fetch(`${base}/mobile/identified/sales`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({operationId:randomUUID(),saleId,version:2,recordedAt:new Date().toISOString(),sale:revised,refund:38100})});assert.equal(response.status,201);
  const tunisDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
  response=await fetch(`${base}/identified-tour/${commercial.id}/${tunisDay}`,{headers:adminHeaders});assert.equal(response.status,200);const journal=await response.json();
  assert.equal(journal.saleRefundTotal,38100);assert.equal(journal.saleRefundEvents[0].saleId,saleId);assert.equal(journal.totalCollected,11900);
  // Un remboursement d'une autre journée bloque le journal mais le diagnostic
  // reste disponible uniquement à l'administrateur authentifié en v5.
  const olderId=randomUUID(),oldAt='2026-10-01T09:00:00.000Z',older={...sale,createdAt:oldAt,syncSaleId:olderId};
  response=await fetch(`${base}/mobile/identified/sales`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({operationId:randomUUID(),saleId:olderId,version:1,recordedAt:oldAt,sale:older,refund:0})});assert.equal(response.status,201);
  response=await fetch(`${base}/mobile/identified/sales`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({operationId:randomUUID(),saleId:olderId,version:2,recordedAt:'2026-10-02T10:00:00.000Z',sale:{...revised,createdAt:oldAt,syncSaleId:olderId},refund:38100})});assert.equal(response.status,201);
  const diagnosticUrl=`${base}/identified-tour/${commercial.id}/2026-10-01/refund-diagnostic`;
  assert.equal((await fetch(diagnosticUrl,{headers:{'X-SLS-Reference-Version':'5'}})).status,401);
  assert.equal((await fetch(diagnosticUrl,{headers:{Authorization:`Bearer ${admin}`}})).status,409);
  response=await fetch(diagnosticUrl,{headers:adminHeaders});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const diagnostic=await response.json();assert.equal(diagnostic.entries.length,1);assert.equal(diagnostic.entries[0].saleId,olderId);assert.equal(diagnostic.entries[0].refund,38100);
  assert.equal((await fetch(`${base}/identified-tour/${commercial.id}/2026-10-01`,{headers:adminHeaders})).status,409);
  // Clôture historique simulée : le diagnostic permet toujours d'obtenir sa
  // version et l'administrateur peut la rouvrir sans lever la garde du journal.
  await pool.query("UPDATE tour_closures SET status='closed',version=1,closed_at=now() WHERE commercial_id=$1 AND journal_date='2026-10-01'",[commercial.id]);
  response=await fetch(diagnosticUrl,{headers:adminHeaders});assert.deepEqual((await response.json()).closure,{status:'closed',version:1});
  const reopen={requestId:randomUUID(),day:'2026-10-01',expectedVersion:1};
  const reopenUrl=`${base}/identified-tour-actions/${commercial.id}/reopen`;
  response=await fetch(reopenUrl,{method:'POST',headers:adminHeaders,body:JSON.stringify(reopen)});assert.equal(response.status,201);
  response=await fetch(reopenUrl,{method:'POST',headers:adminHeaders,body:JSON.stringify(reopen)});assert.equal(response.status,200);assert.equal((await response.json()).status,'duplicate');
  response=await fetch(diagnosticUrl,{headers:adminHeaders});assert.deepEqual((await response.json()).closure,{status:'open',version:2});
  assert.equal((await fetch(`${base}/identified-tour/${commercial.id}/2026-10-01`,{headers:adminHeaders})).status,409);
  const command={operationId:randomUUID(),invoiceId:saleId,expectedVersion:2,recordedAt:new Date().toISOString(),choice:'refund'};
  response=await fetch(`${base}/identified-tour-actions/credit-notes/preview`,{method:'POST',headers:adminHeaders,body:JSON.stringify({clientId,kind:'sale',command})});assert.equal(response.status,200);const review=await response.json();
  response=await fetch(`${base}/identified-tour-actions/credit-notes/reviewed/sales`,{method:'POST',headers:adminHeaders,body:JSON.stringify({command,review})});assert.equal(response.status,201);
  response=await fetch(`${base}/mobile/identified/reference`,{headers:auth});assert.equal((await response.json()).saleStates.find((s:{saleId:string})=>s.saleId===saleId).creditNote.refund,11900);
  response=await fetch(`${base}/mobile/identified/reference`,{headers:{Authorization:`Bearer ${session.token}`}});assert.equal(response.status,409);
 }finally{await stop();if(pool)await pool.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
