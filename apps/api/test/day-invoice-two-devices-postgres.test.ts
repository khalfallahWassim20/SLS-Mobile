/** Deux téléphones fictifs travaillent simultanément sur la même facture. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {dayInvoiceServerSchema,storeDayInvoicePayment} from '../src/day-invoice-store.js';
import {readServerDayInvoiceSource} from '../src/day-invoice-source.js';
import {readDayInvoiceReference} from '../src/day-invoice-reference.js';
import {storeIdentifiedSale} from '../src/identified-operations.js';
import {storeJournalSnapshot} from '../src/journal-store.js';
import {setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';

test('deux téléphones : un seul paiement concurrent peut utiliser le même reste',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');
 const schema='sls_day_two_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});
  await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const clientId=randomUUID(),saleId=randomUUID(),invoiceId=randomUUID(),day='2026-01-01',at=`${day}T09:00:00.000Z`,secret='secret fictif suffisamment long pour les tests';
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[clientId,'Client fictif']);
  const sessions=[];
  for(let i=0;i<2;i++){
   const commercialId=randomUUID(),login=`two.phone${i}`;await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,`Commercial ${i}`]);
   await setCommercialCredentials(pool,'admin',commercialId,{login,password:'mot de passe fictif'});
   const result=await loginCommercial(pool,secret,{login,password:'mot de passe fictif'});assert.ok(result);sessions.push({secret,token:result.token});
  }
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:5,unitPrice:50000,discount:0,vat:0}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},{...sessions[0],enforceMode:true});
  const invoice={id:invoiceId,journalDate:day,clientId,clientName:'Client fictif',sector:'',amount:600000,createdAt:at};
  await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',{...sessions[0],enforceMode:true});
  const first={operationId:randomUUID(),clientId,day,recordedAt:`${day}T09:30:00.000Z`,amount:300000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]};
  assert.equal(await storeDayInvoicePayment(pool,first,sessions[0],readServerDayInvoiceSource),'received');
  const entries=[0,1].map(i=>({...first,operationId:randomUUID(),recordedAt:`${day}T10:0${i}:00.000Z`,amount:400000,preInvoice:{...first.preInvoice,declare:false}}));
  const results=await Promise.allSettled(entries.map((event,i)=>storeDayInvoicePayment(pool!,event,sessions[i],readServerDayInvoiceSource)));
  const accepted=results.flatMap((result,index)=>result.status==='fulfilled'?[index]:[]),rejected=results.flatMap((result,index)=>result.status==='rejected'?[index]:[]);
  assert.equal(accepted.length,1);assert.equal(rejected.length,1);
  assert.match(String((results[rejected[0]] as PromiseRejectedResult).reason),/supérieur|reste/i);
  const count=await pool.query('SELECT count(*)::int AS n FROM identified_day_invoice_payments WHERE client_id=$1',[clientId]);assert.equal(count.rows[0].n,2);
  const ref=await readDayInvoiceReference(pool);assert.equal(ref.clients.find(c=>c.id===clientId)?.serverBalance,'150000');
  assert.equal(ref.dayPayments.filter(p=>p.clientId===clientId).reduce((n,p)=>n+p.amount,0),700000);
  assert.equal(await storeDayInvoicePayment(pool,entries[accepted[0]],sessions[accepted[0]],readServerDayInvoiceSource),'duplicate');
  await assert.rejects(storeDayInvoicePayment(pool,entries[rejected[0]],sessions[rejected[0]],readServerDayInvoiceSource),/supérieur|reste/i);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_day_invoice_payments WHERE client_id=$1',[clientId])).rows[0].n,2);
 }finally{await pool?.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
