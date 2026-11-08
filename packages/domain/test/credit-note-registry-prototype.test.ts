import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {creditNotePrototypeSchema,storePrototypeCreditNote} from '../../../apps/api/src/credit-note-registry-prototype.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {storeIdentifiedSale} from '../../../apps/api/src/identified-operations.js';
import {changeTourClosure} from '../../../apps/api/src/tour-closure-store.js';

test('registre expérimental : reprise identique, refus du deuxième avoir et rollback',async()=>{
 const db=new PGlite();
 try {
  await db.exec(schemaSql);await db.exec(creditNotePrototypeSchema);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>conn,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  const c=await saveCommercial(pool,'admin',{name:'Fictif',active:true}),secret='secret fictif assez long pour le test';
  await setCommercialCredentials(pool,'admin',c.id,{login:'credit.test',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'credit.test',password:'mot de passe fictif'});assert.ok(session);
  const clientId=randomUUID(),invoiceId=randomUUID(),at='2026-11-07T10:00:00.000Z';
  await db.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Client fictif']);
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:invoiceId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId:invoiceId,version:1,recordedAt:at,sale,refund:0},{secret,token:session.token});
  const cmd={operationId:randomUUID(),invoiceId,expectedVersion:1,recordedAt:'2026-11-08T10:00:00.000Z',choice:'refund'},principal={kind:'commercial' as const,secret,token:session.token};
  await assert.rejects(storePrototypeCreditNote(pool,cmd,{...principal,token:'invalide'}),/Session/);
  await assert.rejects(storePrototypeCreditNote(pool,{...cmd,choice:null},principal),/Choisissez/);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM credit_note_prototype_events')).rows[0].n,0);
  const first=await storePrototypeCreditNote(pool,cmd,principal);assert.equal(first.status,'received');assert.equal(first.event.refund,50000);assert.equal(first.event.balanceDelta,-69000);
  await changeTourClosure(pool,c.id,'2026-11-07','close',{id:c.id,role:'commercial'},0);
  const duplicate=await storePrototypeCreditNote(pool,cmd,principal);assert.equal(duplicate.status,'duplicate');assert.deepEqual(duplicate.event,first.event);
  await assert.rejects(storePrototypeCreditNote(pool,{...cmd,choice:'credit'},principal),/déjà utilisé/);
  await assert.rejects(storePrototypeCreditNote(pool,cmd,{kind:'admin',actorId:'admin'}),/déjà utilisé/);
  await changeTourClosure(pool,c.id,'2026-11-07','reopen',{id:'admin',role:'admin'},1);
  await assert.rejects(storePrototypeCreditNote(pool,{...cmd,operationId:randomUUID()},principal),/déjà annulée/);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM credit_note_prototype_events')).rows[0].n,1);
 } finally {await db.close();}
});
