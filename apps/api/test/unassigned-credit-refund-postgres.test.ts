import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale} from '../src/identified-operations.js';
import {storeJournalSnapshot} from '../src/journal-store.js';
import {storePrototypeCreditNote} from '../src/credit-note-registry-prototype.js';
import {storePrototypePreInvoiceCredit} from '../src/pre-invoice-credit-registry-prototype.js';
import {requestTourTransition} from '../src/tour-closure-store.js';

test('PostgreSQL : clôture d’un autre commercial contre remboursement admin non attribué',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_admin_refund_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const a=await saveCommercial(pool,'admin',{name:'Propriétaire fictif',active:true}),b=await saveCommercial(pool,'admin',{name:'Autre commercial',active:true});
  await setCommercialCredentials(pool,'admin',a.id,{login:'admin.refund.a',password:'mot de passe fictif'});await setCommercialCredentials(pool,'admin',b.id,{login:'admin.refund.b',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour les tests',sa=await loginCommercial(pool,secret,{login:'admin.refund.a',password:'mot de passe fictif'}),sb=await loginCommercial(pool,secret,{login:'admin.refund.b',password:'mot de passe fictif'});assert.ok(sa&&sb);
  const auth={secret,token:sa.token,enforceMode:true,creditAware:true},principal={kind:'commercial' as const,secret,token:sb.token},admin={kind:'admin' as const,actorId:'admin'};
  for(let i=1;i<=8;i++){
   const day=`2026-08-${String(i).padStart(2,'0')}`,at=`${day}T09:00:00.000Z`,clientId=randomUUID(),invoiceId=randomUUID();await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,1000000)',[clientId,'Fictif']);
   const sale=i%2===0;
   if(sale){const invoice={createdAt:at,clientId,clientName:'Fictif',syncSaleId:invoiceId,syncVersion:1,lines:[{name:'Huile',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId:invoiceId,version:1,recordedAt:at,sale:invoice,refund:0},auth);}
   else {const invoice={id:invoiceId,clientId,clientName:'Fictif',journalDate:day,createdAt:at,sector:'',amount:600000};await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',auth);
    const receipt={id:randomUUID(),preInvoiceId:invoiceId,clientId,journalDate:day,createdAt:`${day}T10:00:00.000Z`,prePaid:250000,oldDebtPaid:400000,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1000000};await storeJournalSnapshot(pool,{operationId:randomUUID(),version:2,invoice,receipts:[receipt]},'identified',auth);}
   const command={operationId:randomUUID(),invoiceId,expectedVersion:sale?1:2,recordedAt:`${day}T11:00:00.000Z`,choice:'refund' as const},requestId=randomUUID();
   const credit=()=>sale?storePrototypeCreditNote(pool!,command,admin):storePrototypePreInvoiceCredit(pool!,command,admin);
   const close=()=>requestTourTransition(pool!,{requestId,day,expectedVersion:0},principal,true,true);
   const results=await Promise.allSettled(i%4<2?[credit(),close()]:[close(),credit()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(results));
   const status=await pool.query('SELECT status FROM tour_closures WHERE commercial_id=$1 AND journal_date=$2::date',[b.id,day]);
   const received=await pool.query('SELECT count(*)::int AS n FROM credit_note_prototype_operation_ids WHERE operation_id=$1',[command.operationId]);
   assert.notEqual(status.rows[0]?.status==='closed',received.rows[0].n===1);
   if(received.rows[0].n===1){assert.equal((await credit()).status,'duplicate');await assert.rejects(close(),/caisse non attribuée/);}
   else {assert.equal((await close()).status,'duplicate');await assert.rejects(credit(),/clôturée/);}
  }
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
