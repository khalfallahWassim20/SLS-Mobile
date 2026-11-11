import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale} from '../src/identified-operations.js';
import {requestTourTransition} from '../src/tour-closure-store.js';

test('PostgreSQL : remboursement et clôture concurrents ne peuvent être acceptés ensemble',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_refund_close_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const commercial=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});await setCommercialCredentials(pool,'admin',commercial.id,{login:'refund.race',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour les tests',session=await loginCommercial(pool,secret,{login:'refund.race',password:'mot de passe fictif'});assert.ok(session);
  const auth={secret,token:session.token,enforceMode:true,creditAware:true},principal={kind:'commercial' as const,secret,token:session.token};
  for(let i=1;i<=8;i++){
   const day=`2026-10-${String(i*2-1).padStart(2,'0')}`,refundDay=`2026-10-${String(i*2).padStart(2,'0')}`,at=`${day}T09:00:00.000Z`,clientId=randomUUID(),saleId=randomUUID();await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Fictif']);
   const line={name:'Huile',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900};
   const sale={createdAt:at,clientId,clientName:'Fictif',syncSaleId:saleId,syncVersion:1,lines:[line],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
   await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},auth);
   const revision={operationId:randomUUID(),saleId,version:2,recordedAt:`${refundDay}T10:00:00.000Z`,sale:{...sale,syncVersion:2,lines:[{...line,unitPrice:10000}],total:11900,paid:11900,remaining:0},refund:38100};
   const close=()=>requestTourTransition(pool!,{requestId:randomUUID(),day,expectedVersion:0},principal,true,true),edit=()=>storeIdentifiedSale(pool!,revision,auth);
   const results=await Promise.allSettled(i%2?[edit(),close()]:[close(),edit()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(results));
   const status=await pool.query('SELECT status FROM tour_closures WHERE commercial_id=$1 AND journal_date=$2::date',[commercial.id,day]);
   const received=await pool.query('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1 AND version=2',[saleId]);
   assert.notEqual(status.rows[0]?.status==='closed',received.rows[0].n===1);
  }
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
