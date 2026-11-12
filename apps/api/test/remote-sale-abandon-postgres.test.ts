/** Course réelle : l'envoi et l'abandon ne peuvent jamais gagner tous les deux. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale} from '../src/identified-operations.js';
import {abandonRemoteSalePrototype} from '../src/remote-sale-abandon-prototype.js';
test('PostgreSQL : course entre abandon et envoi de la même révision',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_abandon_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif assez long pour les tests',commercial=await saveCommercial(pool,'admin',{name:'Test',active:true});
  await setCommercialCredentials(pool,'admin',commercial.id,{login:'abandon.test',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'abandon.test',password:'mot de passe fictif'});assert.ok(session);const auth={secret,token:session.token};
  const clientId=randomUUID();await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[clientId,'Test']);
  for(let i=0;i<8;i++){
   const saleId=randomUUID(),date='2026-11-07T09:00:00.000Z',sale={createdAt:date,clientId,clientName:'Test',syncSaleId:saleId,syncVersion:1,lines:[{name:'Huile',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:0,remaining:119000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
   await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:date,sale,refund:0},auth);
   const event={operationId:randomUUID(),saleId,version:2,recordedAt:'2026-11-07T10:00:00.000Z',sale:{...sale,syncVersion:2},refund:0};
   const [send,abandon]=await Promise.allSettled(i%2?[storeIdentifiedSale(pool,event,auth),abandonRemoteSalePrototype(pool,event,auth)]:[abandonRemoteSalePrototype(pool,event,auth),storeIdentifiedSale(pool,event,auth)]);
   const [write,result]=i%2?[send,abandon]:[abandon,send];assert.equal(result.status,'fulfilled');if(result.status!=='fulfilled')throw result.reason;
   const outcome=result.value as Awaited<ReturnType<typeof abandonRemoteSalePrototype>>;
   if(outcome.status==='already-received')assert.equal(write.status,'fulfilled');else assert.equal(write.status,'rejected');
   const counts=await pool.query('SELECT (SELECT count(*)::int FROM identified_sale_events WHERE operation_id=$1) AS sent,(SELECT count(*)::int FROM remote_sale_abandon_prototype WHERE operation_id=$1) AS abandoned',[event.operationId]);
   assert.equal(counts.rows[0].sent+counts.rows[0].abandoned,1);
   assert.equal((await abandonRemoteSalePrototype(pool,event,auth)).status,outcome.status);
  }
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
