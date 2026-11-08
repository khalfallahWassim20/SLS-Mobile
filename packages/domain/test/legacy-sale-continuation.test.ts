import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {storeIdentifiedSale} from '../../../apps/api/src/identified-operations.js';
import {readIdentifiedReference} from '../../../apps/api/src/identified-reference.js';
import {readIdentifiedJournalDay} from '../../../apps/api/src/identified-journal-day.js';
import {IdentifiedOverlap} from '../../../apps/api/src/identified-overlap.js';

test('une vente partagée ancienne peut être modifiée sans réattribuer sa création ni doubler le solde',async()=>{
 const db=new PGlite(),secret='secret fictif pour cet essai de transition';
 try {
  await db.exec(schemaSql);const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>conn,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  const c=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});await setCommercialCredentials(pool,'admin',c.id,{login:'fictif',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'fictif',password:'mot de passe fictif'});assert.ok(session);const auth={secret,token:session.token};
  const clientId=randomUUID(),saleId=randomUUID(),day='2026-11-10',at='2026-11-10T09:00:00.000Z';
  await db.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[clientId,'Client fictif',1000000]);
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  const oldEvent={operationId:randomUUID(),saleId,version:1,sale,refund:0};
  await db.query('INSERT INTO demo_sale_events(operation_id,sale_id,version,client_id,payload,payload_hash) VALUES($1,$2,1,$3,$4::jsonb,$5)',[oldEvent.operationId,saleId,clientId,JSON.stringify(oldEvent),'legacy']);
  const next={operationId:randomUUID(),saleId,version:2,recordedAt:'2026-11-11T10:00:00.000Z',refund:0,sale:{...sale,syncVersion:2,lines:[{...sale.lines[0],quantity:2}],total:238000,remaining:188000}};
  await assert.rejects(storeIdentifiedSale(pool,{...next,version:1,sale:{...next.sale,syncVersion:1},recordedAt:at},auth),IdentifiedOverlap);
  assert.equal(await storeIdentifiedSale(pool,next,auth),'received');assert.equal(await storeIdentifiedSale(pool,next,auth),'duplicate');
  const reference=await readIdentifiedReference(pool);assert.equal(reference.clients[0].serverBalance,'1188000');assert.equal(reference.saleStates.length,1);assert.equal(reference.saleStates[0].version,2);
  // La création historique reste non attribuée même si une nouvelle version a un acteur authentifié.
  const dayView=await readIdentifiedJournalDay(pool,c.id,day);assert.equal(dayView.rows.length,0);
  const record=await db.query<{commercial_id:string;version:number}>('SELECT commercial_id,version FROM identified_sale_events');assert.equal(record.rows[0].commercial_id,c.id);assert.equal(record.rows[0].version,2);
  // Un nouveau précédent partagé après transition rend le rapprochement ambigu et bloque la projection.
  await db.query('INSERT INTO demo_sale_events(operation_id,sale_id,version,client_id,payload,payload_hash) VALUES($1,$2,2,$3,$4::jsonb,$5)',[randomUUID(),saleId,clientId,JSON.stringify(oldEvent),'bad']);
  await assert.rejects(readIdentifiedReference(pool),/incompatible/);
 } finally {await db.close();}
});
