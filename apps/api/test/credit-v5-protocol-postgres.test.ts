/** Test isolé uniquement : le protocole v5 n'est pas monté dans le serveur actif. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale} from '../src/identified-operations.js';
import {storePrototypeCreditNote} from '../src/credit-note-registry-prototype.js';
import {readPrototypeCreditReference} from '../src/credit-note-reference-prototype.js';
import {validatePrototypeCreditReference} from '../../mobile/credit-note-reference-prototype.js';

async function waitBlocked(pool:pg.Pool,pid:number){const end=Date.now()+5000;while(Date.now()<end){const r=await pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid]);if(r.rows[0].n)return;await new Promise(r=>setTimeout(r,25));}throw Error('Verrou non observé.');}
test('PostgreSQL : protocole v5 et ancien protocole concurrent avec un avoir',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_credit_v5_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});
  await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const c=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true}),secret='secret fictif assez long pour les tests';
  await setCommercialCredentials(pool,'admin',c.id,{login:'protocol.test',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'protocol.test',password:'mot de passe fictif'});assert.ok(session);
  const clientId=randomUUID();await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,1000000)',[clientId,'Client fictif']);
  const id=randomUUID(),at='2026-11-08T09:00:00.000Z',sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:id,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  const original={operationId:randomUUID(),saleId:id,version:1,recordedAt:at,sale,refund:0},auth={secret,token:session.token,enforceMode:true,creditAware:true};
  assert.equal(await storeIdentifiedSale(pool,original,auth),'received');
  const command={operationId:randomUUID(),invoiceId:id,expectedVersion:1,recordedAt:'2026-11-08T10:00:00.000Z',choice:'refund' as const};
  const lock=await pool.connect(),creditConn=await pool.connect();
  try{
   await lock.query('BEGIN');await lock.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",['identified-sale',id]);
   const wrapped={connect:async()=>({query:creditConn.query.bind(creditConn),release:()=>{}})} as unknown as pg.Pool;
   const pendingCredit=storePrototypeCreditNote(wrapped,command,{kind:'commercial',secret,token:session.token}).then(v=>({v,error:null as unknown}),error=>({v:null,error}));
   await waitBlocked(pool,lock.processID);
   const otherId=randomUUID(),other={...original,operationId:randomUUID(),saleId:otherId,sale:{...sale,syncSaleId:otherId}};
   const pendingSale=storeIdentifiedSale(pool,other,auth).then(v=>({v,error:null as unknown}),error=>({v:null,error}));
   await waitBlocked(pool,creditConn.processID);await lock.query('COMMIT');
   assert.equal((await pendingCredit).v?.status,'received');assert.equal((await pendingSale).v,'received');
   const thirdId=randomUUID(),third={...original,operationId:randomUUID(),saleId:thirdId,sale:{...sale,syncSaleId:thirdId}};
   await assert.rejects(storeIdentifiedSale(pool,third,{...auth,creditAware:false}),/avoirs existent/);
   await assert.rejects(storeIdentifiedSale(pool,{...original,operationId:randomUUID(),version:2,recordedAt:'2026-11-08T11:00:00.000Z',sale:{...sale,syncVersion:2}},auth),/annulée/);
   const ref=validatePrototypeCreditReference(await readPrototypeCreditReference(pool));assert.equal(ref.clients[0].serverBalance,'1069000');assert.equal(ref.saleStates.find(s=>s.saleId===id)?.cancelled,true);
  }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();creditConn.release();}
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});

test('PostgreSQL : statuts client versionnés, migration répétée et changements concurrents',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_status_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:5});
  await pool.query(schemaSql);await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const id=randomUUID();await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[id,'Client fictif']);
  const a=await pool.connect();
  try{
   await a.query('BEGIN');await a.query('UPDATE clients SET active=false WHERE id=$1',[id]);
   const pending=pool.query('UPDATE clients SET active=true WHERE id=$1 RETURNING status_revision::text AS revision',[id]);
   await waitBlocked(pool,a.processID);await a.query('COMMIT');
   assert.equal((await pending).rows[0].revision,'3');
   await pool.query('UPDATE clients SET name=$2,status_revision=99 WHERE id=$1',[id,'Nom fictif']);
   const reference=validatePrototypeCreditReference(await readPrototypeCreditReference(pool,false));
   assert.equal(reference.clients[0].active,true);assert.equal(reference.clients[0].statusRevision,'3');
   await pool.query(schemaSql);
   await pool.query('UPDATE clients SET active=false WHERE id=$1',[id]);
   assert.equal((await readPrototypeCreditReference(pool,false)).clients[0].statusRevision,'4');
  }finally{await a.query('ROLLBACK').catch(()=>{});a.release();}
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});

test('PostgreSQL : lecture admin et avoir concurrent gardent un instantané cohérent',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_snapshot_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try {
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});
  await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const c=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true}),secret='secret fictif assez long pour les tests';
  await setCommercialCredentials(pool,'admin',c.id,{login:'snapshot.test',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'snapshot.test',password:'mot de passe fictif'});assert.ok(session);
  const clientId=randomUUID();await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,1000000)',[clientId,'Client fictif']);
  const saleId=randomUUID(),at='2026-11-08T09:00:00.000Z',sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},{secret,token:session.token,enforceMode:true,creditAware:true});
  const conn=await pool.connect();let resume!:()=>void,ready!:()=>void;
  const paused=new Promise<void>(r=>resume=r),snapshotReady=new Promise<void>(r=>ready=r);
  const wrapped={connect:async()=>({query:async(sql:string,args?:unknown[])=>{if(sql.startsWith('SELECT DISTINCT ON (sale_id) sale_id AS "saleId",version,client_id')){ready();await paused;}return conn.query(sql,args as any);},release:()=>{}})} as unknown as pg.Pool;
  try {
   const {readPrototypeAdminCreditSnapshot,readPrototypeAdminCreditSaleHistory}=await import('../src/credit-note-admin-snapshot-prototype.js');
   const reading=readPrototypeAdminCreditSnapshot(wrapped);await snapshotReady;
   const note={operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:'2026-11-08T10:00:00.000Z',choice:'refund' as const};
   const writing=storePrototypeCreditNote(pool,note,{kind:'admin',actorId:'admin'});
   await waitBlocked(pool,conn.processID);resume();
   const before=await reading;assert.equal(before.balances[0].balance,'1069000');assert.equal(before.sales[0].cancelled,false);
   assert.equal((await writing).status,'received');
   const after=await readPrototypeAdminCreditSnapshot(pool);assert.equal(after.balances[0].balance,'1000000');assert.equal(after.sales[0].cancelled,true);assert.equal(after.sales[0].sale.total,119000);
   const history=await readPrototypeAdminCreditSaleHistory(pool,saleId);assert.equal(history?.cancelled,true);assert.equal(history?.creditNote?.refund,50000);
  }finally{resume();await conn.query('ROLLBACK').catch(()=>{});conn.release();}
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
