import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {storeJournalSnapshot} from '../../../apps/api/src/journal-store.js';
import {storeIdentifiedSale,storeIdentifiedSettlement} from '../../../apps/api/src/identified-operations.js';
import {IdentifiedOverlap} from '../../../apps/api/src/identified-overlap.js';

test('transition : refuse les collisions avant de comptabiliser dans le nouvel espace',async()=>{
 const db=new PGlite(),secret='secret fictif assez long pour ce test';
 try {
  await db.exec(schemaSql);
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>conn,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  const c=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});
  await setCommercialCredentials(pool,'admin',c.id,{login:'commercial.test',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'commercial.test',password:'mot de passe fictif'});assert.ok(session);const auth={token:session.token,secret};
  const clientId=randomUUID(),day='2026-11-10',at='2026-11-10T10:00:00.000Z';
  await db.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Client fictif']);
  const invoice={id:randomUUID(),clientId,clientName:'Client fictif',journalDate:day,sector:'',amount:600000,createdAt:at};
  const legacy={operationId:randomUUID(),version:1,invoice,receipts:[]};assert.equal(await storeJournalSnapshot(pool,legacy,'sync'),'received');
  const conflicting={...legacy,operationId:randomUUID(),invoice:{...invoice,id:randomUUID()}};
  await assert.rejects(storeJournalSnapshot(pool,conflicting,'identified',auth),IdentifiedOverlap);
  await assert.rejects(storeJournalSnapshot(pool,legacy,'identified',auth),IdentifiedOverlap);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM identified_journal_events')).rows[0].n,0);
  const legacySale=randomUUID();await db.query('INSERT INTO demo_sale_events(operation_id,sale_id,version,client_id,payload,payload_hash) VALUES($1,$2,1,$3,$4::jsonb,$5)',[randomUUID(),legacySale,clientId,'{}','hash']);
  const makeSale=(saleId:string,operationId:string)=>({operationId,saleId,version:1,recordedAt:at,refund:0,sale:{createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:0,remaining:119000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''}});
  await assert.rejects(storeIdentifiedSale(pool,makeSale(legacySale,randomUUID()),auth),IdentifiedOverlap);
  const operationId=randomUUID();assert.equal(await storeIdentifiedSale(pool,makeSale(randomUUID(),operationId),auth),'received');
  const payment={operationId,settlement:{syncOperationId:operationId,createdAt:at,clientId,clientName:'Client fictif',amount:1000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}};
  await assert.rejects(storeIdentifiedSettlement(pool,payment,auth),IdentifiedOverlap);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM identified_settlements')).rows[0].n,0);
 } finally {await db.close();}
});
