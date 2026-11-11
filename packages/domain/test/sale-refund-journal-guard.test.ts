import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {PoolClient} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {assertSaleRefundJournalSafe} from '../../../apps/api/src/sale-refund-journal-guard-prototype.js';

test('remboursement de vente : protection des journaux du créateur et de l’auteur, sans bloquer les autres',async()=>{
 const db=new PGlite();try {
  await db.exec(schemaSql);
  const a=randomUUID(),b=randomUUID(),c=randomUUID(),client=randomUUID(),sale=randomUUID();
  for(const id of [a,b,c])await db.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[id,id]);
  await db.query('INSERT INTO clients(id,name) VALUES($1,$2)',[client,'Fictif']);
  async function event(version:number,actor:string,date:string|null,refund:number){await db.query(`INSERT INTO identified_sale_events(operation_id,sale_id,version,client_id,commercial_id,journal_date,event_date,payload,payload_hash) VALUES($1,$2,$3,$4,$5,'2026-11-08',$6::date,$7::jsonb,'test')`,[randomUUID(),sale,version,client,actor,date,JSON.stringify({refund})]);}
  const tx=db as unknown as PoolClient;
  await event(1,a,'2026-11-08',0);await event(2,a,'2026-11-08',100);
  await assertSaleRefundJournalSafe(tx,a,'2026-11-08');
  await event(3,b,'2026-11-09',0);
  await assertSaleRefundJournalSafe(tx,a,'2026-11-08');await assertSaleRefundJournalSafe(tx,b,'2026-11-09');
  await event(4,b,'2026-11-10',3000);
  await assert.rejects(assertSaleRefundJournalSafe(tx,a,'2026-11-08'),/remboursement.*exports précédents/i);
  await assert.rejects(assertSaleRefundJournalSafe(tx,b,'2026-11-10'),/remboursement/i);
  await assertSaleRefundJournalSafe(tx,b,'2026-11-09');await assertSaleRefundJournalSafe(tx,c,'2026-11-10');
  // Une ancienne révision sans date exploitable reste bloquante pour son auteur.
  await db.query('UPDATE identified_sale_events SET event_date=NULL WHERE sale_id=$1 AND version=4',[sale]);
  await assert.rejects(assertSaleRefundJournalSafe(tx,b,'2026-11-09'),/remboursement/i);
 }finally{await db.close();}
});

test('clôture v5 : remboursement reçu bloque une nouvelle clôture sans empêcher une réouverture ni une reprise exacte',async()=>{
 const {saveCommercial,setCommercialCredentials}=await import('../../../apps/api/src/commercials.js');
 const {loginCommercial}=await import('../../../apps/api/src/commercial-session.js');
 const {requestTourTransition}=await import('../../../apps/api/src/tour-closure-store.js');
 const {readPrototypeCreditJournal}=await import('../../../apps/api/src/credit-note-journal-prototype.js');
 const db=new PGlite();try{
  await db.exec(schemaSql);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={query:(sql:string,params?:unknown[])=>db.query(sql,params),connect:async()=>conn} as unknown as import('pg').Pool;
  const a=await saveCommercial(pool,'admin',{name:'A fictif',active:true});
  await setCommercialCredentials(pool,'admin',a.id,{login:'refund.test',password:'mot de passe fictif'});
  const secret='secret pour essai fictif 123456789',session=await loginCommercial(pool,secret,{login:'refund.test',password:'mot de passe fictif'});assert.ok(session);
  const principal={kind:'commercial' as const,secret,token:session.token},day='2026-11-08',requestId=randomUUID();
  const first=await requestTourTransition(pool,{requestId,day,expectedVersion:0},principal,true,true);assert.equal(first.status,'received');
  const client=randomUUID(),sale=randomUUID();await db.query('INSERT INTO clients(id,name) VALUES($1,$2)',[client,'Fictif']);
  const payload={sale:{createdAt:'2026-11-08T09:00:00.000Z',clientId:client,clientName:'Fictif',total:1000,paid:1000,remaining:0},refund:0};
  for(const [version,refund] of [[1,0],[2,500]])await db.query(`INSERT INTO identified_sale_events(operation_id,sale_id,version,client_id,commercial_id,journal_date,event_date,payload,payload_hash) VALUES($1,$2,$3,$4,$5,$6::date,$7::date,$8::jsonb,'test')`,[randomUUID(),sale,version,client,a.id,day,version===1?day:'2026-11-09',JSON.stringify({...payload,refund})]);
  assert.equal((await requestTourTransition(pool,{requestId,day,expectedVersion:0},principal,true,true)).status,'duplicate');
  await requestTourTransition(pool,{requestId:randomUUID(),day,expectedVersion:1},{kind:'admin',actorId:'admin',commercialId:a.id},true,true);
  await assert.rejects(requestTourTransition(pool,{requestId:randomUUID(),day,expectedVersion:2},principal,true,true),/remboursement/i);
  const status=await db.query('SELECT status,version FROM tour_closures WHERE commercial_id=$1 AND journal_date=$2::date',[a.id,day]);assert.deepEqual(status.rows[0],{status:'open',version:2});
  // Tester le refus directement avant la construction des totaux, sans dépendre
  // d'un payload de vente minimal non conforme au schéma du journal.
  await assert.rejects(readPrototypeCreditJournal(pool,a.id,day),/remboursement/i);
 }finally{await db.close();}
});

test('même commercial et même journée : le remboursement est déjà dans le paiement net et la clôture reste possible',async()=>{
 const {saveCommercial,setCommercialCredentials}=await import('../../../apps/api/src/commercials.js');
 const {loginCommercial}=await import('../../../apps/api/src/commercial-session.js');
 const {storeIdentifiedSale}=await import('../../../apps/api/src/identified-operations.js');
 const {requestTourTransition}=await import('../../../apps/api/src/tour-closure-store.js');
 const {readPrototypeCreditJournal}=await import('../../../apps/api/src/credit-note-journal-prototype.js');
 const db=new PGlite();try{
  await db.exec(schemaSql);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={query:(sql:string,params?:unknown[])=>db.query(sql,params),connect:async()=>conn} as unknown as import('pg').Pool;
  const a=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});await setCommercialCredentials(pool,'admin',a.id,{login:'refund.same',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour le test',session=await loginCommercial(pool,secret,{login:'refund.same',password:'mot de passe fictif'});assert.ok(session);
  const auth={secret,token:session.token,enforceMode:true,creditAware:true},clientId=randomUUID(),saleId=randomUUID(),day='2026-11-08',at=`${day}T09:00:00.000Z`;
  await db.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Client fictif']);
  const line={name:'Huile',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900};
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[line],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},auth);
  const revised={...sale,syncVersion:2,lines:[{...line,unitPrice:10000}],total:11900,paid:11900,remaining:0};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:2,recordedAt:`${day}T10:00:00.000Z`,sale:revised,refund:38100},auth);
  const journal=await readPrototypeCreditJournal(pool,a.id,day);
  assert.equal(journal.totalBilled,11900);assert.equal(journal.totalCollected,11900);assert.equal(journal.collectedAfterRefunds,11900);
  assert.equal(journal.rows[0].tourPaid,11900);
  const principal={kind:'commercial' as const,secret,token:session.token};
  const {storePrototypeCreditNote}=await import('../../../apps/api/src/credit-note-registry-prototype.js');
  await storePrototypeCreditNote(pool,{operationId:randomUUID(),invoiceId:saleId,expectedVersion:2,recordedAt:`${day}T10:30:00.000Z`,choice:'refund'},principal);
  const cancelled=await readPrototypeCreditJournal(pool,a.id,day);
  assert.equal(cancelled.totalCollected,11900);assert.equal(cancelled.creditRefundTotal,11900);assert.equal(cancelled.collectedAfterRefunds,0);assert.equal(cancelled.billedAfterCredits,0);
  assert.equal((await requestTourTransition(pool,{requestId:randomUUID(),day,expectedVersion:0},principal,true,true)).status,'received');
  await assert.rejects(storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:3,recordedAt:`${day}T11:00:00.000Z`,sale:{...revised,syncVersion:3},refund:0},auth),/clôtur|avoir|annulée/i);
 }finally{await db.close();}
});
