/* Authentification réelle, transport HTTP local fictif, stockage SQLite isolé
 * et routes PostgreSQL v6 uniquement dans un schéma éphémère. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServer,type Server} from 'node:http';
import express from 'express';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {identifiedCommercialRoutes} from '../src/identified-tour-routes.js';
import {setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial,verifyCommercialSession} from '../src/commercial-session.js';
import {identifiedDeviceSchema,getDeviceIdentity} from '../../mobile/identified-device.js';
import {creditReferencePrototypeSchema} from '../../mobile/credit-note-reference-cache-prototype.js';
import {dayInvoiceReferenceCacheSchema,readDayInvoiceReferenceCache} from '../../mobile/day-invoice-reference-cache.js';
import {isolatedDayInvoiceSetupSchema,readIsolatedDayInvoiceSetup,initializeIsolatedDayInvoice} from '../../mobile/day-invoice-isolated-setup.js';
import {connectIsolatedDayInvoice} from '../../mobile/day-invoice-isolated-connect.js';
import {dayInvoiceQueueSchema} from '../../mobile/day-invoice-queue.js';
import {offlineCreditPrototypeSchema} from '../../mobile/credit-note-offline-prototype.js';
import {createDayInvoiceTransportPrototype} from '../../mobile/day-invoice-transport.js';
import {previewDayInvoiceMigrationOnline} from '../../mobile/day-invoice-migration-preview.js';
import {assertLegacyMobileDayInvoiceSafe} from '../../mobile/day-invoice-legacy-guard.js';

test('connexion de l’espace isolé : HTTP authentifié, référence réelle, liaison SQLite et refus de lignée modifiée',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL fictive requise');
 const schema='sls_connect_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined,server:Server|undefined,phone:DatabaseSync|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});await pool.query(schemaSql);
  const commercialId=randomUUID(),clientId=randomUUID(),articleId=randomUUID(),secret='secret fictif exclusivement pour les tests';
  await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[clientId,'Client fictif']);
  await pool.query("INSERT INTO articles(id,code,name,purchase_ttc,sale_ttc,vat_rate) VALUES($1,'X','Produit fictif',200000,250000,1900)",[articleId]);
  await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  await setCommercialCredentials(pool,'admin',commercialId,{login:'sls.test',password:'mot de passe fictif'});
  const app=express();app.use(express.json());const dbPool=pool;
  app.post('/api/mobile/session/login',async(req,res)=>{const result=await loginCommercial(dbPool,secret,req.body);if(!result){res.status(401).json({error:'refus'});return;}res.json(result);});
  app.get('/api/mobile/session',async(req,res)=>{const user=await verifyCommercialSession(dbPool,secret,req.get('Authorization')?.replace(/^Bearer /,'')??'');if(!user){res.status(401).json({error:'refus'});return;}res.json({commercial:user});});
  app.use('/api/mobile/identified',identifiedCommercialRoutes(pool,secret,{dayInvoiceTestOnly:true}));
  server=createServer(app);await new Promise<void>((resolve,reject)=>server!.listen(0,'127.0.0.1',()=>resolve()).once('error',reject));const addr=server.address();assert.ok(addr&&typeof addr!=='string');const local=`http://127.0.0.1:${addr.port}`,origin='http://192.168.1.20:3001';
  phone=new DatabaseSync(':memory:');const db=phone;
  db.exec(`${identifiedDeviceSchema}${creditReferencePrototypeSchema}${dayInvoiceReferenceCacheSchema}${isolatedDayInvoiceSetupSchema}
   CREATE TABLE sales_outbox(id INTEGER);CREATE TABLE journal_sync_outbox(id INTEGER);CREATE TABLE tour_pre_invoices(id TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT);`);
  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{db.prepare(sql).run(...args);}};
  const transaction=async<T>(work:()=>Promise<T>)=>{db.exec('BEGIN');try{const value=await work();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
  const io={request:(url:string,options:{method:string;headers:Record<string,string>;body?:string})=>{assert.ok(url.startsWith(origin+'/'));return fetch(local+url.slice(origin.length),options);},readIdentity:()=>getDeviceIdentity(tx),readSetup:()=>readIsolatedDayInvoiceSetup(tx),initialize:(identity:Parameters<typeof initializeIsolatedDayInvoice>[1]['identity'],pin:Parameters<typeof initializeIsolatedDayInvoice>[1]['pin'],name:string,reference:unknown,check:()=>void)=>transaction(()=>initializeIsolatedDayInvoice(tx,{identity,pin,name},reference,check)),isCurrent:()=>true};
  await assert.rejects(connectIsolatedDayInvoice(origin,'sls.test','mauvais mot de passe',io),/incorrect/);
  assert.equal(await readIsolatedDayInvoiceSetup(tx),null);assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,0);
  const linked=await connectIsolatedDayInvoice(origin,'sls.test','mot de passe fictif',io);
  assert.equal(linked.setup.identity.commercialId,commercialId);const cached=await readDayInvoiceReferenceCache(tx,linked.setup.identity);assert.ok(cached);assert.equal(cached.clients[0].id,clientId);assert.equal(cached.articles[0].id,articleId);
  const stored=db.prepare('SELECT payload FROM day_invoice_reference_cache').get() as {payload:string};assert.doesNotMatch(stored.payload,/purchase|achat/i);
  assert.deepEqual((await connectIsolatedDayInvoice(origin,'sls.test','mot de passe fictif',io)).setup,linked.setup);
  // Second téléphone fictif, avec référence v4 et aucune écriture v6.
  const legacy=new DatabaseSync(':memory:');try{
   legacy.exec(`${identifiedDeviceSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}
    CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
    CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);
    CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);`);
   const old=await io.request(`${origin}/api/mobile/identified/reference`,{method:'GET',headers:{Authorization:`Bearer ${linked.session.token}`}});assert.equal(old.status,200);const oldPayload=JSON.stringify(await old.json());
   legacy.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(commercialId,origin);legacy.prepare('INSERT INTO identified_reference_cache VALUES(1,?,?,?)').run(commercialId,origin,oldPayload);
   const legacyTx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>legacy.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>legacy.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{legacy.prepare(sql).run(...args);}};
   const transport=createDayInvoiceTransportPrototype(linked.session,linked.setup.identity,linked.setup.pin,{request:io.request,isCurrentSession:()=>true,allowPrivateHttp:true});
   const migrationIO={verifyServer:transport.verifyServer,fetchReference:transport.fetchReference,check:transport.check,digest:async(text:string)=>createHash('sha256').update(text).digest('hex'),transaction:async<T>(work:(t:typeof legacyTx)=>Promise<T>)=>{legacy.exec('BEGIN EXCLUSIVE');try{const value=await work(legacyTx);legacy.exec('COMMIT');return value;}catch(e){legacy.exec('ROLLBACK');throw e;}}};
   const report=await previewDayInvoiceMigrationOnline(linked.setup.identity,linked.setup.identity,migrationIO);assert.equal(report.clientCount,1);assert.equal(report.migrationAuthorized,false);assert.equal(report.pendingOperations,0);
   assert.equal(legacy.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,0);assert.equal((legacy.prepare('SELECT payload FROM identified_reference_cache').get() as {payload:string}).payload,oldPayload);await assertLegacyMobileDayInvoiceSafe(legacyTx);
   await pool.query('UPDATE server_lineage_identity SET lineage_id=$1 WHERE id=1',[randomUUID()]);
   await assert.rejects(previewDayInvoiceMigrationOnline(linked.setup.identity,linked.setup.identity,migrationIO),/Lignée serveur incohérente/);
   assert.equal(legacy.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,0);
  }finally{legacy.close();}

  await assert.rejects(connectIsolatedDayInvoice(origin,'sls.test','mot de passe fictif',io),/Lignée serveur différente/);
  assert.deepEqual(await readIsolatedDayInvoiceSetup(tx),linked.setup);assert.equal((db.prepare('SELECT payload FROM day_invoice_reference_cache').get() as {payload:string}).payload,stored.payload);
 }finally{phone?.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));if(pool)await pool.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
