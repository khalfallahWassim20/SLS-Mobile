import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {Pool,PoolClient} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {storeIdentifiedSale} from '../../../apps/api/src/identified-operations.js';
import {changeTourClosure} from '../../../apps/api/src/tour-closure-store.js';
import {lockCreditNoteSale} from '../../../apps/api/src/credit-note-sale-lock.js';

test('préparation serveur : montant et version proviennent de la facture, clôtures contrôlées',async()=>{
 const db=new PGlite();
 try {
  await db.exec(schemaSql);
  // PGlite ne supporte pas les advisory locks : ce test ne valide pas la concurrence PostgreSQL.
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>conn,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  const c=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});
  const other=await saveCommercial(pool,'admin',{name:'Autre fictif',active:true});
  await setCommercialCredentials(pool,'admin',c.id,{login:'credit.test',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour le test',session=await loginCommercial(pool,secret,{login:'credit.test',password:'mot de passe fictif'});assert.ok(session);
  const clientId=randomUUID(),invoiceId=randomUUID(),at='2026-11-07T23:30:00.000Z';
  await db.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Client fictif']);
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:invoiceId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  const event={operationId:randomUUID(),saleId:invoiceId,version:1,recordedAt:at,sale,refund:0};
  await storeIdentifiedSale(pool,event,{secret,token:session.token});
  const actor={id:other.id,role:'commercial' as const},command={operationId:randomUUID(),invoiceId,expectedVersion:1,recordedAt:'2026-11-09T10:00:00.000Z',choice:'credit' as const};
  async function run(cmd=command,a:{id:string;role:'admin'|'commercial'}=actor){await db.exec('BEGIN');try{return await lockCreditNoteSale(conn as unknown as PoolClient,a,cmd);}finally{await db.exec('ROLLBACK');}}
  const source=await run();assert.deepEqual(source,{invoiceId,version:1,total:119000,netPaid:50000,clientId,ownerId:c.id,invoiceDay:'2026-11-08'});
  await assert.rejects(run({...command,expectedVersion:2}),/périmée/);
  await assert.rejects(run({...command,recordedAt:'2026-11-07T20:00:00.000Z'}),/antérieure/);
  await assert.rejects(run({...command,operationId:event.operationId}),/utilisé/);
  await changeTourClosure(pool,c.id,'2026-11-08','close',{id:c.id,role:'commercial'},0);
  await assert.rejects(run(),/clôturé/);
  await assert.rejects(run(command,{id:'admin',role:'admin'}),/clôturé/);
  await changeTourClosure(pool,c.id,'2026-11-08','reopen',{id:'admin',role:'admin'},1);
  await changeTourClosure(pool,other.id,'2026-11-09','close',{id:other.id,role:'commercial'},0);
  await assert.rejects(run(),/clôturé/);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM identified_sale_events')).rows[0].n,1);
 } finally {await db.close();}
});
