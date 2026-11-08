/** Essai volontaire sur PostgreSQL : crée et supprime uniquement un schéma temporaire aléatoire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { schemaSql } from '../src/schema.js';
import { storeJournalSnapshot, JournalConflict } from '../src/journal-store.js';
import { readJournalReference } from '../src/journal-reference.js';
import {changeTourClosure, ClosureConflict, readTourClosure, requestTourTransition} from '../src/tour-closure-store.js';
import {setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale,storeIdentifiedSettlement} from '../src/identified-operations.js';
import {lockSyncMode,LegacySyncDisabled} from '../src/tour-sync-mode.js';
import {IdentifiedOverlap} from '../src/identified-overlap.js';

dotenv.config({path:'apps/api/.env'});
test('PostgreSQL : doublons et versions concurrentes, isolés dans un schéma temporaire', async () => {
 const url=process.env.DATABASE_URL;
 if (!url) throw new Error('DATABASE_URL manquante dans apps/api/.env.');
 const schema='sls_journal_test_'+randomUUID().replaceAll('-','');
 const root=new pg.Pool({connectionString:url});
 let isolated: pg.Pool | undefined, created=false;
 try {
  await root.query(`CREATE SCHEMA "${schema}"`); created=true;
  isolated=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:5});
  await isolated.query(schemaSql); await isolated.query(schemaSql);
  const clientId=randomUUID(),id=randomUUID(), op1=randomUUID();
  await isolated.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[clientId,'Client test temporaire',1000000]);
  const invoice={id,journalDate:'2026-11-05',clientId,clientName:'Client test temporaire',sector:'Test',amount:600000,createdAt:'2026-11-05T09:00:00.000Z'};
  const first={operationId:op1,version:1,invoice,receipts:[]};
  const result=await Promise.all([storeJournalSnapshot(isolated,first,'sync'),storeJournalSnapshot(isolated,first,'sync')]);
  assert.deepEqual(result.sort(),['duplicate','received']);
  const receipt=(id:string,prePaid:number)=>({id,preInvoiceId:invoice.id,clientId,journalDate:invoice.journalDate,createdAt:'2026-11-05T10:00:00.000Z',prePaid,oldDebtPaid:0,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1000000});
  const updates=[100000,200000].map(amount=>({operationId:randomUUID(),version:2,invoice,receipts:[receipt(randomUUID(),amount)]}));
  const simultaneous=await Promise.allSettled(updates.map(e=>storeJournalSnapshot(isolated!,e,'sync')));
  assert.equal(simultaneous.filter(r=>r.status==='fulfilled').length,1);
  const failure=simultaneous.find(r=>r.status==='rejected'); assert.ok(failure && failure.status==='rejected' && failure.reason instanceof JournalConflict);
  const stored=await isolated.query('SELECT payload FROM sync_journal_events ORDER BY version DESC LIMIT 1');
  const paid=stored.rows[0].payload.receipts[0].prePaid;
  const reference=await readJournalReference(isolated);
  assert.equal(reference.clients[0].serverBalance,String(1000000+600000-paid));
  assert.equal((await isolated.query('SELECT count(*)::int AS count FROM sync_journal_events')).rows[0].count,2);
  // Deux téléphones enregistrent une facture différente pour le même client/jour.
  const competing=[1,2].map(()=>({operationId:randomUUID(),version:1,invoice:{...invoice,id:randomUUID(),journalDate:'2026-11-06'},receipts:[]}));
  const outcomes=await Promise.allSettled(competing.map(e=>storeJournalSnapshot(isolated!,e,'sync')));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  const conflict=outcomes.find(r=>r.status==='rejected'); assert.ok(conflict && conflict.status==='rejected' && conflict.reason instanceof JournalConflict);
  const dayRows=await isolated.query("SELECT count(*)::int AS count FROM sync_journal_invoices WHERE client_id=$1 AND journal_date='2026-11-06'",[clientId]);
  assert.equal(dayRows.rows[0].count,1);

  // Clôtures concurrentes : une seule transition de la version 0 peut réussir.
  const commercialId=randomUUID();
  await isolated.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial test temporaire']);
  const actor={id:commercialId,role:'commercial' as const};
  const closures=await Promise.allSettled([1,2].map(()=>changeTourClosure(isolated!,commercialId,'2026-11-07','close',actor,0)));
  assert.equal(closures.filter(r=>r.status==='fulfilled').length,1);
  const closureFailure=closures.find(r=>r.status==='rejected');
  assert.ok(closureFailure && closureFailure.status==='rejected' && closureFailure.reason instanceof ClosureConflict);
  assert.equal((await readTourClosure(isolated,commercialId,'2026-11-07')).version,1);
  assert.equal((await isolated.query('SELECT count(*)::int AS count FROM tour_closure_events')).rows[0].count,1);
  // Une écriture et une clôture simultanées se sérialisent sur le même verrou de journée.
  const secret='secret fictif pour le test de concurrence';
  await setCommercialCredentials(isolated,'admin',commercialId,{login:'test.concurrent',password:'mot de passe fictif'});
  const session=await loginCommercial(isolated,secret,{login:'test.concurrent',password:'mot de passe fictif'});
  assert.ok(session);
  const signed={secret,token:session.token},raceDay='2026-11-09';
  const concurrentInvoice={operationId:randomUUID(),version:1,invoice:{...invoice,id:randomUUID(),journalDate:raceDay},receipts:[]};
  const [write,close]=await Promise.allSettled([
   storeJournalSnapshot(isolated,concurrentInvoice,'identified',signed),
   changeTourClosure(isolated,commercialId,raceDay,'close',actor,0)
  ]);
  assert.equal(close.status,'fulfilled');
  if(write.status==='rejected') assert.ok(write.reason instanceof JournalConflict);
  const eventCount=(await isolated.query('SELECT count(*)::int AS count FROM identified_journal_events')).rows[0].count;
  assert.equal(eventCount,write.status==='fulfilled'?1:0);
  if(write.status==='fulfilled') assert.equal(await storeJournalSnapshot(isolated,concurrentInvoice,'identified',signed),'duplicate');
  else await assert.rejects(storeJournalSnapshot(isolated,concurrentInvoice,'identified',signed),/clôturé/);
  // Vente et règlement concurrentiels face à la clôture d'une autre journée.
  const saleId=randomUUID(),opId=randomUUID(),settlementId=randomUUID();
  const concurrentSale={operationId:opId,saleId,version:1,recordedAt:'2026-11-10T10:00:00.000Z',refund:0,sale:{createdAt:'2026-11-10T10:00:00.000Z',clientId,clientName:'Client test temporaire',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:0,remaining:119000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''}};
  const concurrentPayment={operationId:settlementId,settlement:{syncOperationId:settlementId,createdAt:'2026-11-10T10:00:00.000Z',clientId,clientName:'Client test temporaire',amount:1000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}};
  const [saleResult,paymentResult,closeResult]=await Promise.allSettled([
   storeIdentifiedSale(isolated,concurrentSale,signed),storeIdentifiedSettlement(isolated,concurrentPayment,signed),
   changeTourClosure(isolated,commercialId,'2026-11-10','close',actor,0)
  ]);
  assert.equal(closeResult.status,'fulfilled');
  for(const result of [saleResult,paymentResult]) if(result.status==='rejected') assert.ok(result.reason instanceof JournalConflict);
  const saleCount=(await isolated.query('SELECT count(*)::int AS count FROM identified_sale_events')).rows[0].count;
  const paymentCount=(await isolated.query('SELECT count(*)::int AS count FROM identified_settlements')).rows[0].count;
  assert.equal(saleCount,saleResult.status==='fulfilled'?1:0);assert.equal(paymentCount,paymentResult.status==='fulfilled'?1:0);
  if(saleResult.status==='fulfilled') assert.equal(await storeIdentifiedSale(isolated,concurrentSale,signed),'duplicate');
  else await assert.rejects(storeIdentifiedSale(isolated,concurrentSale,signed),/clôturé/);
  if(paymentResult.status==='fulfilled') assert.equal(await storeIdentifiedSettlement(isolated,concurrentPayment,signed),'duplicate');
  else await assert.rejects(storeIdentifiedSettlement(isolated,concurrentPayment,signed),/clôturé/);
  // Deux reprises simultanées de la même demande ne produisent qu'une transition.
  const request={requestId:randomUUID(),day:'2026-11-11',expectedVersion:0};
  const principal={kind:'commercial' as const,secret,token:session.token};
  const acks=await Promise.all([requestTourTransition(isolated,request,principal),requestTourTransition(isolated,request,principal)]);
  assert.deepEqual(acks.map(x=>x.status).sort(),['duplicate','received']);
  assert.equal(acks[0].version,1);assert.equal(acks[1].version,1);
  assert.equal((await isolated.query('SELECT count(*)::int AS count FROM tour_closure_events WHERE commercial_id=$1 AND journal_date=$2::date',[commercialId,request.day])).rows[0].count,1);
  // La future bascule ne doit pas dépasser une écriture partagée en cours.
  const writer=await isolated.connect(),switcher=await isolated.connect();
  try {
   await writer.query('BEGIN');assert.equal(await lockSyncMode(writer),'legacy');
   await switcher.query('BEGIN');await switcher.query("SET LOCAL lock_timeout = '150ms'");
   await assert.rejects(switcher.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1"), (e:any)=>e.code==='55P03');
   await switcher.query('ROLLBACK');await writer.query('COMMIT');
   await switcher.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
   // Accusé perdu : les reprises identiques déjà reçues restent possibles.
   assert.equal(await storeJournalSnapshot(isolated,first,'sync'),'duplicate');
   const blocked={operationId:randomUUID(),version:1,invoice:{...invoice,id:randomUUID(),journalDate:'2026-11-12'},receipts:[]};
   await assert.rejects(storeJournalSnapshot(isolated,blocked,'sync'),LegacySyncDisabled);
   // Deux types d'écritures identifiées utilisant le même UUID ne peuvent être reçus simultanément.
   const sharedId=randomUUID(),freshSale=randomUUID(),guarded={...signed,enforceMode:true};
   const duplicateSale={...concurrentSale,operationId:sharedId,saleId:freshSale,sale:{...concurrentSale.sale,syncSaleId:freshSale,createdAt:'2026-11-13T10:00:00.000Z'},recordedAt:'2026-11-13T10:00:00.000Z'};
   const duplicateSettlement={...concurrentPayment,operationId:sharedId,settlement:{...concurrentPayment.settlement,syncOperationId:sharedId,createdAt:'2026-11-13T10:00:00.000Z'}};
   const conflicting=await Promise.allSettled([storeIdentifiedSale(isolated,duplicateSale,guarded),storeIdentifiedSettlement(isolated,duplicateSettlement,guarded)]);
   assert.equal(conflicting.filter(x=>x.status==='fulfilled').length,1);
   const rejected=conflicting.find(x=>x.status==='rejected');assert.ok(rejected&&rejected.status==='rejected'&&rejected.reason instanceof IdentifiedOverlap);
   // Deux modifications concurrentes d'une vente héritée ne peuvent créer qu'une version suivante.
   const oldId=randomUUID(),oldOp=randomUUID(),oldAt='2026-11-14T08:00:00.000Z';
   const oldSale={...concurrentSale.sale,syncSaleId:oldId,createdAt:oldAt};
   const oldEvent={operationId:oldOp,saleId:oldId,version:1,sale:oldSale,refund:0};
   await isolated.query('INSERT INTO demo_sale_events(operation_id,sale_id,version,client_id,payload,payload_hash) VALUES($1,$2,1,$3,$4::jsonb,$5)',[oldOp,oldId,clientId,JSON.stringify(oldEvent),'fixture']);
   const nextSales=[1,2].map(()=>({operationId:randomUUID(),saleId:oldId,version:2,recordedAt:'2026-11-14T09:00:00.000Z',refund:0,sale:{...oldSale,syncVersion:2}}));
   const continuations=await Promise.allSettled(nextSales.map(s=>storeIdentifiedSale(isolated!,s,guarded)));
   assert.equal(continuations.filter(x=>x.status==='fulfilled').length,1);
   const failed=continuations.find(x=>x.status==='rejected');assert.ok(failed&&failed.status==='rejected'&&failed.reason instanceof JournalConflict);


  } finally {writer.release();switcher.release();}





 } finally {
  if (isolated) await isolated.end();
  if (created) await root.query(`DROP SCHEMA "${schema}" CASCADE`);
  await root.end();
 }
});
