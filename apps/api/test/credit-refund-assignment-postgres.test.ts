import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale} from '../src/identified-operations.js';
import {storePrototypeCreditNote} from '../src/credit-note-registry-prototype.js';
import {assignAdminCreditRefund} from '../src/credit-refund-assignment-prototype.js';
import {requestTourTransition} from '../src/tour-closure-store.js';
import {readPrototypeCreditJournal} from '../src/credit-note-journal-prototype.js';

test('PostgreSQL : attribution concurrente, reprise et protection de caisse',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');const root=new pg.Pool({connectionString:url}),schema='sls_assign_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const a=await saveCommercial(pool,'admin',{name:'Commercial A',active:true}),b=await saveCommercial(pool,'admin',{name:'Commercial B',active:true});
  await setCommercialCredentials(pool,'admin',a.id,{login:'assign.a',password:'mot de passe fictif'});await setCommercialCredentials(pool,'admin',b.id,{login:'assign.b',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour les tests',sa=await loginCommercial(pool,secret,{login:'assign.a',password:'mot de passe fictif'}),sb=await loginCommercial(pool,secret,{login:'assign.b',password:'mot de passe fictif'});assert.ok(sa&&sb);
  const auth={secret,token:sa.token,enforceMode:true,creditAware:true};
  for(let i=1;i<=6;i++){
   const day=`2026-07-0${i}`,at=`${day}T09:00:00.000Z`,clientId=randomUUID(),saleId=randomUUID();await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Fictif']);
   const sale={createdAt:at,clientId,clientName:'Fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Huile',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
   await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},auth);
   const command={operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:`${day}T10:00:00.000Z`,choice:'refund' as const};await storePrototypeCreditNote(pool,command,{kind:'admin',actorId:'admin'});
   const left={requestId:randomUUID(),noteOperationId:command.operationId,refund:50000,commercialId:a.id},right={...left,requestId:randomUUID(),commercialId:b.id};
   const outcomes=await Promise.allSettled([assignAdminCreditRefund(pool,left,'admin'),assignAdminCreditRefund(pool,right,'admin')]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
   const winner=outcomes[0].status==='fulfilled'?left:right,loser=winner===left?right:left;assert.equal((await assignAdminCreditRefund(pool,winner,'admin')).status,'duplicate');await assert.rejects(assignAdminCreditRefund(pool,loser,'admin'),/déjà/);
   const report=await readPrototypeCreditJournal(pool,winner.commercialId,day);assert.equal(report.creditRefundTotal,50000);assert.equal(report.creditCashEvents[0].cashAssignment?.requestId,winner.requestId);
   const token=winner.commercialId===a.id?sa.token:sb.token;await assert.rejects(requestTourTransition(pool,{requestId:randomUUID(),day,expectedVersion:0},{kind:'commercial',secret,token},true,true),/rapprochement du téléphone/);
   const other=winner.commercialId===a.id?sb.token:sa.token;assert.equal((await requestTourTransition(pool,{requestId:randomUUID(),day,expectedVersion:0},{kind:'commercial',secret,token:other},true,true)).status,'received');
  }
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
