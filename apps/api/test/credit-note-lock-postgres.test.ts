/** PostgreSQL réel : les verrous consultatifs ne sont pas simulés. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale} from '../src/identified-operations.js';
import {lockCreditNoteSale} from '../src/credit-note-sale-lock.js';
import {lockTourClosure} from '../src/tour-closure-store.js';

dotenv.config({path:'apps/api/.env'});
// Attend une vraie attente PostgreSQL, pas un simple délai chronométré.
async function waitBlocked(pool:pg.Pool,pid:number) {
 const end=Date.now()+5000;
 while(Date.now()<end) {
  const r=await pool.query('SELECT cardinality(pg_blocking_pids($1)) AS n',[pid]);
  if(Number(r.rows[0].n)>0)return;
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 throw Error(`La connexion ${pid} n’a pas été bloquée`);
}
test('PostgreSQL : verrou avoir contre modification et clôture concurrentes',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const schema='sls_credit_lock_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});
 let pool:pg.Pool|undefined,created=false;
 try {
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;
  pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});
  await pool.query(schemaSql);
  const commercial=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});
  await setCommercialCredentials(pool,'admin',commercial.id,{login:'credit.test',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour un test PostgreSQL',session=await loginCommercial(pool,secret,{login:'credit.test',password:'mot de passe fictif'});assert.ok(session);
  const clientId=randomUUID(),invoiceId=randomUUID(),at='2026-11-07T10:00:00.000Z';
  await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Client fictif']);
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:invoiceId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:0,remaining:119000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  const first={operationId:randomUUID(),saleId:invoiceId,version:1,recordedAt:at,sale,refund:0};
  await storeIdentifiedSale(pool,first,{secret,token:session.token});
  const cmd={operationId:randomUUID(),invoiceId,expectedVersion:1,recordedAt:'2026-11-08T10:00:00.000Z',choice:null};
  const actor={id:commercial.id,role:'commercial' as const};
  const a=await pool.connect(), b=await pool.connect();
  try {
   await a.query('BEGIN');await b.query('BEGIN');
   const source=await lockCreditNoteSale(a,actor,cmd);assert.equal(source.version,1);
   // La même clé que celle de l'écriture d'une vente est effectivement détenue.
   const tried=await b.query("SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS ok",['identified-sale',invoiceId]);
   assert.equal(tried.rows[0].ok,false);await b.query('ROLLBACK');
   // Utilise le vrai service de modification, sur une connexion identifiable.
   const second={operationId:randomUUID(),saleId:invoiceId,version:2,recordedAt:'2026-11-08T09:00:00.000Z',sale:{...sale,syncVersion:2},refund:0};
   const wrapped={connect:async()=>({query:b.query.bind(b),release:()=>{}})} as unknown as pg.Pool;
   const pendingSale=storeIdentifiedSale(wrapped,second,{secret,token:session.token});
   // Capture immédiatement les erreurs, même en cas d'échec de l'attente ci-dessous.
   const saleOutcome=pendingSale.then(value=>({value,error:null as unknown}),error=>({value:null,error}));
   await waitBlocked(pool,b.processID);await a.query('COMMIT');
   const saleResult=await saleOutcome;assert.equal(saleResult.error,null);assert.equal(saleResult.value,'received');
   await a.query('BEGIN');await assert.rejects(lockCreditNoteSale(a,actor,cmd),/périmée/);await a.query('ROLLBACK');
   // Une clôture en cours verrouille la journée ; après son commit l'avoir est refusé.
   await b.query('BEGIN');await lockTourClosure(b,commercial.id,'2026-11-07');
   await b.query("UPDATE tour_closures SET status='closed',version=1,closed_at=now() WHERE commercial_id=$1 AND journal_date=$2",[commercial.id,'2026-11-07']);
   await a.query('BEGIN');const pending=lockCreditNoteSale(a,actor,{...cmd,operationId:randomUUID(),expectedVersion:2});
   const outcome=pending.then(()=>({error:null as unknown}),error=>({error}));
   await waitBlocked(pool,a.processID);await b.query('COMMIT');
   const result=await outcome;assert.match(String(result.error),/clôturé/);await a.query('ROLLBACK');
  } finally {await a.query('ROLLBACK').catch(()=>{});await b.query('ROLLBACK').catch(()=>{});a.release();b.release();}
 } finally {if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
