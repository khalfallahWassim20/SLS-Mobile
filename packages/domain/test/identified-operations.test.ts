import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {changeTourClosure} from '../../../apps/api/src/tour-closure-store.js';
import {storeIdentifiedSale,storeIdentifiedSettlement} from '../../../apps/api/src/identified-operations.js';

test('ventes et règlements identifiés : verrouillage, identité et reprise sans doublon',async()=>{
 const db=new PGlite(),secret='secret fictif de test suffisamment long';
 try {
  await db.exec(schemaSql);await db.exec(schemaSql);
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={query:(sql:string,params?:unknown[])=>db.query(sql,params),connect:async()=>conn} as unknown as Pool;
  const c=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});
  const other=await saveCommercial(pool,'admin',{name:'Autre fictif',active:true});
  await setCommercialCredentials(pool,'admin',c.id,{login:'fictif.un',password:'mot de passe fictif'});
  await setCommercialCredentials(pool,'admin',other.id,{login:'fictif.deux',password:'autre mot de passe'});
  const a=await loginCommercial(pool,secret,{login:'fictif.un',password:'mot de passe fictif'}),b=await loginCommercial(pool,secret,{login:'fictif.deux',password:'autre mot de passe'});assert.ok(a&&b);
  const s={secret,token:a.token},otherSession={secret,token:b.token};
  const clientId=randomUUID();await db.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Client fictif']);
  const saleId=randomUUID();
  // En Tunisie, 23h30 UTC appartient au lendemain.
  const sale={createdAt:'2026-11-07T23:30:00.000Z',clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:0,remaining:119000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  const event={operationId:randomUUID(),saleId,version:1,sale,refund:0};
  const payId=randomUUID(),settlement={operationId:payId,settlement:{syncOperationId:payId,createdAt:'2026-11-07T23:31:00.000Z',clientId,clientName:'Client fictif',amount:1000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}};
  await assert.rejects(storeIdentifiedSale(pool,event,{secret,token:'invalide'}),/Session/);
  await assert.rejects(storeIdentifiedSale(pool,{...event,sale:{...sale,total:1}},s),/Totaux/);
  assert.equal(await storeIdentifiedSale(pool,event,s),'received');
  assert.equal(await storeIdentifiedSettlement(pool,settlement,s),'received');
  await assert.rejects(storeIdentifiedSale(pool,event,otherSession),/utilisé/);
  await assert.rejects(storeIdentifiedSettlement(pool,settlement,otherSession),/utilisé/);
  await changeTourClosure(pool,c.id,'2026-11-08','close',{id:c.id,role:'commercial'},0);
  assert.equal(await storeIdentifiedSale(pool,event,s),'duplicate');
  assert.equal(await storeIdentifiedSettlement(pool,settlement,s),'duplicate');
  const changed={operationId:randomUUID(),saleId,version:2,sale:{...sale,syncVersion:2},refund:0};
  const newPayment={...settlement,operationId:randomUUID(),settlement:{...settlement.settlement,syncOperationId:randomUUID()}};
  newPayment.settlement.syncOperationId=newPayment.operationId;
  await assert.rejects(storeIdentifiedSale(pool,changed,s),/clôturé/);
  await assert.rejects(storeIdentifiedSettlement(pool,newPayment,s),/clôturé/);
  await changeTourClosure(pool,c.id,'2026-11-08','reopen',{id:'admin',role:'admin'},1);
  assert.equal(await storeIdentifiedSale(pool,changed,s),'received');
  const shared={operationId:randomUUID(),saleId,version:3,sale:{...sale,syncVersion:3},refund:0};
  assert.equal(await storeIdentifiedSale(pool,shared,otherSession),'received');
  await changeTourClosure(pool,c.id,'2026-11-08','close',{id:c.id,role:'commercial'},2);
  const blocked={operationId:randomUUID(),saleId,version:4,sale:{...sale,syncVersion:4},refund:0};
  await assert.rejects(storeIdentifiedSale(pool,blocked,otherSession),/clôturé/);
  assert.equal(await storeIdentifiedSettlement(pool,newPayment,otherSession),'received');
  const history=await db.query<{commercial_id:string;journal_date:string}>('SELECT commercial_id,journal_date::text FROM identified_sale_events ORDER BY version');
  assert.deepEqual(history.rows.map(r=>[r.commercial_id,r.journal_date]),[[c.id,'2026-11-08'],[c.id,'2026-11-08'],[other.id,'2026-11-08']]);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM demo_sale_events')).rows[0].n,0);
 } finally {await db.close();}
});
