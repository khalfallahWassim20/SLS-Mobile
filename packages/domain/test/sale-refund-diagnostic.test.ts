import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {storeIdentifiedSale} from '../../../apps/api/src/identified-operations.js';
import {readSaleRefundDiagnostic} from '../../../apps/api/src/sale-refund-diagnostic-prototype.js';

test('diagnostic des remboursements entre jours et commerciaux : lecture sans modification, contrôle des preuves',async()=>{
 const db=new PGlite();try{
  await db.exec(schemaSql);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const conn={query:(sql:string,args?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,args),release:()=>{}};
  const pool={query:(sql:string,args?:unknown[])=>db.query(sql,args),connect:async()=>conn} as unknown as Pool;
  const a=await saveCommercial(pool,'admin',{name:'Alice fictive',active:true}),b=await saveCommercial(pool,'admin',{name:'Bob fictif',active:true}),c=await saveCommercial(pool,'admin',{name:'Chloé fictive',active:true});
  const secret='secret fictif suffisant pour les tests';
  await setCommercialCredentials(pool,'admin',a.id,{login:'diag.alice',password:'mot de passe fictif'});await setCommercialCredentials(pool,'admin',b.id,{login:'diag.bob',password:'mot de passe fictif'});
  const sa=await loginCommercial(pool,secret,{login:'diag.alice',password:'mot de passe fictif'}),sb=await loginCommercial(pool,secret,{login:'diag.bob',password:'mot de passe fictif'});assert.ok(sa&&sb);
  const clientId=randomUUID(),saleId=randomUUID(),at='2026-11-08T09:00:00.000Z';await db.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Fictif']);
  const line={name:'Huile',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900},sale={createdAt:at,clientId,clientName:'Fictif',syncSaleId:saleId,syncVersion:1,lines:[line],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},{secret,token:sa.token,creditAware:true});
  const op=randomUUID(),revised={...sale,syncVersion:2,lines:[{...line,unitPrice:10000}],total:11900,paid:11900,remaining:0};
  await storeIdentifiedSale(pool,{operationId:op,saleId,version:2,recordedAt:'2026-11-09T10:00:00.000Z',sale:revised,refund:38100},{secret,token:sb.token,creditAware:true});
  // Une deuxième vente du créateur, remboursée le même jour, est agrégée
  // séparément sans ajouter ce mouvement aux remboursements bloquants.
  const sameId=randomUUID(),sameSale={...sale,syncSaleId:sameId};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId:sameId,version:1,recordedAt:at,sale:sameSale,refund:0},{secret,token:sa.token,creditAware:true});
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId:sameId,version:2,recordedAt:'2026-11-08T10:00:00.000Z',sale:{...revised,syncSaleId:sameId},refund:38100},{secret,token:sa.token,creditAware:true});
  const owner=await readSaleRefundDiagnostic(pool,a.id,'2026-11-08'),actor=await readSaleRefundDiagnostic(pool,b.id,'2026-11-09');
  assert.deepEqual(owner.saleCashPreview.available&&[owner.saleCashPreview.received,owner.saleCashPreview.refund,owner.saleCashPreview.net],[100000,38100,61900]);
  assert.deepEqual(actor.saleCashPreview.available&&[actor.saleCashPreview.received,actor.saleCashPreview.refund,actor.saleCashPreview.net],[0,38100,-38100]);
  assert.equal(owner.entries.length,1);assert.deepEqual(owner.entries,actor.entries);assert.equal(owner.entries[0].refund,38100);assert.equal(owner.entries[0].previousPaid,50000);assert.equal(owner.entries[0].currentPaid,11900);assert.equal(owner.entries[0].actorName,'Bob fictif');assert.equal(owner.entries[0].ownerName,'Alice fictive');
  assert.equal((await readSaleRefundDiagnostic(pool,c.id,'2026-11-09')).entries.length,0);assert.equal((await readSaleRefundDiagnostic(pool,b.id,'2026-11-08')).entries.length,0);
  const originalHash=await db.query<{payload_hash:string}>('SELECT payload_hash FROM identified_sale_events WHERE operation_id=$1',[op]);
  await db.query("UPDATE identified_sale_events SET payload_hash='corruption' WHERE operation_id=$1",[op]);
  await assert.rejects(readSaleRefundDiagnostic(pool,a.id,'2026-11-08'),/incohérent/);
  await db.query('UPDATE identified_sale_events SET payload_hash=$1 WHERE operation_id=$2',[originalHash.rows[0].payload_hash,op]);
  await db.query('UPDATE identified_sale_events SET event_date=NULL WHERE operation_id=$1',[op]);const unknown=await readSaleRefundDiagnostic(pool,b.id,'2026-11-10');assert.equal(unknown.entries[0].refundDay,null);assert.equal(unknown.saleCashPreview.available,false);
  await db.query("UPDATE identified_sale_events SET event_date='2026-11-09' WHERE operation_id=$1",[op]);
  await db.query('DELETE FROM identified_sale_events WHERE sale_id=$1 AND version=1',[saleId]);
  await assert.rejects(readSaleRefundDiagnostic(pool,b.id,'2026-11-09'),/incohérent/);
  // La base est jetée après le contrôle de chaîne incomplète.

  const count=await db.query<{n:number}>('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1',[saleId]);assert.equal(count.rows[0].n,1);
 }finally{await db.close();}
});
