import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import express from 'express';
import {createServer,type Server} from 'node:http';
import {identifiedCommercialRoutes} from '../src/identified-tour-routes.js';
import {schemaSql} from '../src/schema.js';
import {dayInvoiceServerSchema} from '../src/day-invoice-store.js';
import {setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeDayInvoiceOldDebt} from '../src/day-invoice-old-debt.js';
import {storeJournalSnapshot} from '../src/journal-store.js';
import {storeIdentifiedSettlement} from '../src/identified-operations.js';
import {readDayInvoiceReference} from '../src/day-invoice-reference.js';
import {storeDayInvoicePayment} from '../src/day-invoice-store.js';
import {readServerDayInvoiceSource} from '../src/day-invoice-source.js';

test('ancienne dette explicite : plafond, concurrence, reprise et facture indépendante',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');
 const schema='sls_debt_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined,server:Server|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);
  const clientId=randomUUID(),commercialId=randomUUID(),day='2026-01-01',at='2026-01-01T09:00:00.000Z';
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[clientId,'Client fictif',100000]);await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif suffisamment long pour les tests';await setCommercialCredentials(pool,'admin',commercialId,{login:'debt.test',password:'mot de passe fictif'});const login=await loginCommercial(pool,secret,{login:'debt.test',password:'mot de passe fictif'});assert.ok(login);const session={secret,token:login.token};
  const invoice={id:randomUUID(),journalDate:day,clientId,clientName:'Client fictif',sector:'',amount:600000,createdAt:at};
  await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',{...session,enforceMode:true});
  const debt=(amount:number)=>{const operationId=randomUUID();return {invoiceDay:day,event:{operationId,settlement:{syncOperationId:operationId,createdAt:at,clientId,clientName:'Client fictif',amount,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}}};};
  const first=debt(60000);assert.equal(await storeDayInvoiceOldDebt(pool,first,session),'received');assert.equal(await storeDayInvoiceOldDebt(pool,first,session),'duplicate');
  const app=express();app.use(express.json());app.use('/normal',identifiedCommercialRoutes(pool,secret));app.use('/test',identifiedCommercialRoutes(pool,secret,{dayInvoiceTestOnly:true}));server=createServer(app);
  await new Promise<void>((resolve,reject)=>server!.listen(0,'127.0.0.1',()=>resolve()).once('error',reject));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const post=(path:string,auth:boolean)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${login.token}`}:{})},body:JSON.stringify(first)});
  assert.equal((await post('/normal/day-invoice-old-debt',true)).status,404);assert.equal((await post('/test/day-invoice-old-debt',false)).status,401);
  const retry=await post('/test/day-invoice-old-debt',true);assert.equal(retry.status,200);assert.deepEqual(await retry.json(),{status:'duplicate',operationId:first.event.operationId});

  await assert.rejects(storeDayInvoiceOldDebt(pool,debt(40001),session),/supérieur/);
  const competing=await Promise.allSettled([storeDayInvoiceOldDebt(pool,debt(30000),session),storeDayInvoiceOldDebt(pool,debt(30000),session)]);assert.equal(competing.filter(x=>x.status==='fulfilled').length,1);
  const payment={operationId:randomUUID(),clientId,day,recordedAt:at,amount:200000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoice.id,version:1,total:600000,declare:true},sales:[]};
  assert.equal(await storeDayInvoicePayment(pool,payment,session,readServerDayInvoiceSource),'received');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_day_invoice_old_debt')).rows[0].n,2);
  const reference=await readDayInvoiceReference(pool,true);assert.equal(reference.oldDebtMarkers.length,2);assert.equal(reference.clients.find(c=>c.id===clientId)?.serverBalance,'410000');
  await assert.rejects(storeIdentifiedSettlement(pool,debt(1000).event,{...session,enforceMode:true}),/ancien traitement/);
  await pool.query('UPDATE identified_day_invoice_old_debt SET invoice_day=$1::date WHERE operation_id=$2',['2026-01-02',first.event.operationId]);
  await assert.rejects(readDayInvoiceReference(pool,true),/Marqueur de dette incohérent/);

 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await pool?.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
