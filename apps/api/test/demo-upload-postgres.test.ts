import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import {schemaSql} from '../src/schema.js';
import {uploadDemoQueue,type DemoQueueEntry} from '../../mobile/demo-upload.js';
import {uploadJournalQueue,acknowledgeJournalQueueEntry,type JournalQueueItem} from '../../mobile/journal-upload.js';
import {DatabaseSync} from 'node:sqlite';

test('HTTP réel : accusés démo identifiés, réponse perdue et reprise sans double écriture',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const schema='sls_demo_ack_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let server:ReturnType<typeof spawn>|undefined,created=false,logs='';
 const port=await new Promise<number>((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string')return reject(Error('Port indisponible'));s.close(()=>resolve(a.port));});});
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;
  const isolated=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});try{await isolated.query(schemaSql);}finally{await isolated.end();}
  const token='jeton-partage-fictif-superieur-a-32-caracteres',password='mot de passe fictif',hash=await bcrypt.hash(password,4);
  server=spawn(process.execPath,['--import','tsx','apps/api/src/server.ts'],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:url,PGOPTIONS:`-c search_path=${schema}`,PORT:String(port),API_HOST:'127.0.0.1',JWT_SECRET:'secret fictif suffisamment long pour les tests',ADMIN_USERNAME:'admin',ADMIN_PASSWORD_HASH:hash,MOBILE_DEMO_TOKEN:token,MOBILE_JOURNAL_SYNC:'1'}});
  server.stdout?.on('data',d=>{logs+=d.toString()});server.stderr?.on('data',d=>{logs+=d.toString()});
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Serveur indisponible : '+logs)),15000);server!.once('exit',code=>{clearTimeout(timeout);reject(Error('Serveur arrêté '+code+' : '+logs))});server!.stdout!.on('data',()=>{if(logs.includes('API de développement prête')){clearTimeout(timeout);resolve()}})});
  const base=`http://127.0.0.1:${port}`;
  const request=(path:string,body:unknown,auth?:string)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-SLS-Reference-Version':'3',...(auth?{Authorization:'Bearer '+auth}:{})},body:JSON.stringify(body)});
  const login=await request('/api/login',{username:'admin',password});assert.equal(login.status,200);const admin=(await login.json() as {token:string}).token;
  const clientResponse=await request('/api/clients',{name:'Client fictif',sector:'',address:'',taxId:'',phone:'',openingBalance:0,creditLimit:0,active:true},admin);assert.equal(clientResponse.status,201);const clientId=(await clientResponse.json() as {id:string}).id;
  const unusedResponse=await request('/api/clients',{name:'Client à supprimer',sector:'',address:'',taxId:'',phone:'',openingBalance:0,creditLimit:0,active:true},admin);assert.equal(unusedResponse.status,201);const unused=(await unusedResponse.json() as {id:string}).id;
  const remove=(id:string,auth?:string)=>fetch(`${base}/api/clients/${id}`,{method:'DELETE',headers:auth?{Authorization:`Bearer ${auth}`}:{}});
  assert.equal((await remove(unused)).status,401);
  const deleted=await remove(unused,admin);assert.equal(deleted.status,200);assert.deepEqual(await deleted.json(),{status:'deleted',id:unused});assert.equal((await remove(unused,admin)).status,404);
  const clientList=await fetch(`${base}/api/clients`,{headers:{Authorization:`Bearer ${admin}`}});assert.ok(!(await clientList.json() as {id:string}[]).some(c=>c.id===unused));
  const auditResponse=await fetch(`${base}/api/audit`,{headers:{Authorization:`Bearer ${admin}`}});assert.ok((await auditResponse.json() as {entityId:string;action:string}[]).some(a=>a.entityId===unused&&a.action==='suppression'));
  const saleId=randomUUID(),saleOp=randomUUID(),payId=randomUUID(),at='2026-11-10T08:00:00.000Z';
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:210084,discount:0,vat:1900}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  const event={operationId:saleOp,saleId,version:1,sale,refund:0},payment={operationId:payId,settlement:{syncOperationId:payId,createdAt:at,clientId,clientName:'Client fictif',amount:1000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}};
  const late={...event,sale:{...event.sale,clientId:unused,clientName:'Client à supprimer'}};
  assert.equal((await request('/api/mobile/sales',late,token)).status,400);
  const entries:DemoQueueEntry[]=[{sequence:1,operationId:saleOp,saleId,version:1,payload:JSON.stringify(event),lastError:null},{sequence:2,operationId:payId,saleId:payId,version:1,payload:JSON.stringify(payment),lastError:null}];
  const paths:string[]=[],acks:string[]=[];let lose=true;
  const send=async(path:'sales'|'settlements',entry:DemoQueueEntry)=>{paths.push(path);const response=await fetch(`${base}/api/mobile/${path}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-SLS-Reference-Version':'3'},body:entry.payload});if(lose){lose=false;assert.equal(response.status,201);assert.deepEqual(await response.json(),{status:'reçue',operationId:saleOp});throw Error('réponse perdue');}return response;};
  await assert.rejects(uploadDemoQueue(entries,send,async e=>{acks.push(e.operationId)}),/réponse perdue/);assert.deepEqual(acks,[]);
  assert.equal(await uploadDemoQueue(entries,send,async e=>{acks.push(e.operationId)}),2);assert.deepEqual(acks,[saleOp,payId]);assert.deepEqual(paths,['sales','sales','settlements']);
  const refused=await remove(clientId,admin);assert.equal(refused.status,409);assert.equal((await refused.json() as {code:string}).code,'CLIENT_HAS_OPERATIONS');
  const duplicate=await request('/api/mobile/settlements',payment,token);assert.equal(duplicate.status,200);assert.deepEqual(await duplicate.json(),{status:'déjà reçue',operationId:payId});
  assert.equal((await request('/api/mobile/settlements',{...payment,settlement:{...payment.settlement,amount:2000}},token)).status,409);
  const invoiceId=randomUUID(),journalOp=randomUUID(),invoice={id:invoiceId,journalDate:'2026-11-10',clientId,clientName:'Client fictif',sector:'',amount:600000,createdAt:at};
  const journal:JournalQueueItem={sequence:1,operationId:journalOp,invoiceId,version:1,payload:JSON.stringify({operationId:journalOp,version:1,invoice,receipts:[]})};
  const phone=new DatabaseSync(':memory:');try{
   phone.exec('CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,version INTEGER,payload TEXT)');
   phone.prepare('INSERT INTO journal_sync_outbox VALUES(?,?,?,?,?)').run(journal.sequence,journal.operationId,journal.invoiceId,journal.version,journal.payload);
   const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>phone.prepare(sql).get(...p) as T||null,runAsync:async(sql:string,...p:(string|number|null)[])=>{phone.prepare(sql).run(...p)}};
   let lostJournal=true;const sendJournal=async(entry:JournalQueueItem)=>{const response=await fetch(`${base}/api/mobile/journal`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-SLS-Reference-Version':'3'},body:entry.payload});if(lostJournal){lostJournal=false;assert.equal(response.status,201);throw Error('réponse perdue');}return response;};
   await assert.rejects(uploadJournalQueue([journal],sendJournal,e=>acknowledgeJournalQueueEntry(tx,e)),/réponse perdue/);
   assert.equal(phone.prepare('SELECT count(*) AS n FROM journal_sync_outbox').get()?.n,1);
   assert.equal(await uploadJournalQueue([journal],sendJournal,e=>acknowledgeJournalQueueEntry(tx,e)),1);
   assert.equal(phone.prepare('SELECT count(*) AS n FROM journal_sync_outbox').get()?.n,0);
  }finally{phone.close();}
  const read=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});try{assert.equal(Number((await read.query('SELECT count(*) n FROM demo_sale_events')).rows[0].n),1);assert.equal(Number((await read.query('SELECT count(*) n FROM demo_settlements')).rows[0].n),1);assert.equal(Number((await read.query('SELECT count(*) n FROM sync_journal_events')).rows[0].n),1);}finally{await read.end();}
 }finally{if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise<void>(resolve=>server!.once('exit',()=>resolve()));}if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
