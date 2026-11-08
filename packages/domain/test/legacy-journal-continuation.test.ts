import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {canonicalJson} from '../src/index.js';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {storeJournalSnapshot} from '../../../apps/api/src/journal-store.js';
import {readIdentifiedReference} from '../../../apps/api/src/identified-reference.js';
import {readServerJournalDay} from '../../../apps/api/src/journal-day.js';
import {readIdentifiedJournalDay} from '../../../apps/api/src/identified-journal-day.js';
import {changeTourClosure} from '../../../apps/api/src/tour-closure-store.js';

test('facture héritée : continuation sans double comptage ni attribution inventée',async()=>{
 const db=new PGlite(),secret='secret fictif pour test de journal';
 try {
  await db.exec(schemaSql);await db.exec(schemaSql);
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>conn,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  const c=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});await setCommercialCredentials(pool,'admin',c.id,{login:'fictif',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'fictif',password:'mot de passe fictif'});assert.ok(session);const auth={secret,token:session.token};
  const colleague=await saveCommercial(pool,'admin',{name:'Autre commercial fictif',active:true});await setCommercialCredentials(pool,'admin',colleague.id,{login:'autre',password:'mot de passe fictif'});
  const colleagueSession=await loginCommercial(pool,secret,{login:'autre',password:'mot de passe fictif'});assert.ok(colleagueSession);const colleagueAuth={secret,token:colleagueSession.token};
  const clientId=randomUUID(),invoiceId=randomUUID(),day='2026-11-10',at='2026-11-10T09:00:00.000Z';await db.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[clientId,'Client fictif',1000000]);
  const invoice={id:invoiceId,clientId,clientName:'Client fictif',journalDate:day,createdAt:at,sector:'',amount:600000};
  const receipt={id:randomUUID(),preInvoiceId:invoiceId,clientId,journalDate:day,createdAt:at,prePaid:200000,oldDebtPaid:300000,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1000000};
  const legacy={operationId:randomUUID(),version:1,invoice,receipts:[receipt]};assert.equal(await storeJournalSnapshot(pool,legacy,'sync'),'received');
  const nextReceipt={...receipt,id:randomUUID(),prePaid:100000,oldDebtPaid:0};
  const next={operationId:randomUUID(),version:2,invoice,receipts:[receipt,nextReceipt]};
  await assert.rejects(storeJournalSnapshot(pool,{...next,operationId:randomUUID(),version:3},'identified',auth),/Version/);
  await assert.rejects(storeJournalSnapshot(pool,{...next,operationId:randomUUID(),receipts:[{...receipt,prePaid:199999},nextReceipt]},'identified',auth),/Historique/);
  await assert.rejects(storeJournalSnapshot(pool,{...next,operationId:randomUUID(),invoice:{...invoice,id:randomUUID()},receipts:[]},'identified',auth));
  assert.equal(await storeJournalSnapshot(pool,next,'identified',auth),'received');assert.equal(await storeJournalSnapshot(pool,next,'identified',auth),'duplicate');
  await assert.rejects(storeJournalSnapshot(pool,{...next,receipts:[receipt,{...nextReceipt,prePaid:90000}]},'identified',auth));
  const owner=await db.query<{commercial_id:string|null}>('SELECT commercial_id FROM identified_journal_invoices WHERE id=$1',[invoiceId]);assert.equal(owner.rows[0].commercial_id,null);
  const ref=await readIdentifiedReference(pool);assert.equal(ref.clients[0].serverBalance,'1000000');assert.equal(ref.journalStates.length,1);assert.equal(ref.journalStates[0].receipts.length,2);assert.deepEqual(ref.journalProofs[0],{id:invoiceId,version:2,hash:createHash('sha256').update(canonicalJson(next)).digest('hex')});
  // Un identifiant de règlement ancien ne peut pas être recyclé sur une autre facture.
  const otherInvoice={...invoice,id:randomUUID(),journalDate:'2026-11-11'};
  const otherFirst={operationId:randomUUID(),version:1,invoice:otherInvoice,receipts:[]};
  assert.equal(await storeJournalSnapshot(pool,otherFirst,'identified',auth),'received');
  const stolen={...receipt,preInvoiceId:otherInvoice.id,journalDate:otherInvoice.journalDate};
  await assert.rejects(storeJournalSnapshot(pool,{...otherFirst,operationId:randomUUID(),version:2,receipts:[stolen]},'identified',auth),/ancien espace/);
  const dayView=await readIdentifiedJournalDay(pool,c.id,day);assert.equal(dayView.rows.length,0);assert.equal(dayView.inheritedJournalTotal,100000);assert.equal(dayView.totalCollected,100000);assert.equal(dayView.inheritedJournalPayments[0].clientId,clientId);
  await changeTourClosure(pool,c.id,day,'close',{id:c.id,role:'commercial'},0);
  const third={...next,operationId:randomUUID(),version:3,receipts:[receipt,nextReceipt,{...nextReceipt,id:randomUUID(),prePaid:10000}]};
  await assert.rejects(storeJournalSnapshot(pool,third,'identified',auth),/clôturé/);
  // Une autre tournée conserve ses propres droits, sans réattribuer la facture historique.
  assert.equal(await storeJournalSnapshot(pool,third,'identified',colleagueAuth),'received');
  assert.equal((await readIdentifiedJournalDay(pool,c.id,day)).inheritedJournalTotal,100000);
  assert.equal((await readIdentifiedJournalDay(pool,colleague.id,day)).inheritedJournalTotal,10000);
  await changeTourClosure(pool,c.id,day,'reopen',{id:'admin',role:'admin'},1);
  const fourth={...third,operationId:randomUUID(),version:4,receipts:[...third.receipts,{...nextReceipt,id:randomUUID(),prePaid:5000}]};
  assert.equal(await storeJournalSnapshot(pool,fourth,'identified',auth),'received');
  assert.equal((await readIdentifiedJournalDay(pool,c.id,day)).inheritedJournalTotal,105000);
  const after=await readIdentifiedReference(pool);assert.equal(after.clients[0].serverBalance,'985000');
  const combined=await readServerJournalDay(pool,day,'combined');assert.equal(combined.rows.length,1);assert.equal(combined.rows[0].preInvoiceTotal,600000);assert.equal(combined.rows[0].preInvoicePaid,315000);assert.equal(combined.rows[0].oldDebtPaid,300000);
 } finally {await db.close();}
});
