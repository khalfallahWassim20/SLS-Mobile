import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {storeIdentifiedSale} from '../../../apps/api/src/identified-operations.js';
import {storeJournalSnapshot} from '../../../apps/api/src/journal-store.js';
import {storePrototypeCreditNote} from '../../../apps/api/src/credit-note-registry-prototype.js';
import {storePrototypePreInvoiceCredit} from '../../../apps/api/src/pre-invoice-credit-registry-prototype.js';
import {readPrototypeCreditJournal} from '../../../apps/api/src/credit-note-journal-prototype.js';

test('avoirs vente et préétablie : sorties chez l’auteur, dette ancienne conservée chez le propriétaire',async()=>{
 const db=new PGlite();try{
  await db.exec(schemaSql);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}},pool={query:(sql:string,params?:unknown[])=>db.query(sql,params),connect:async()=>conn} as unknown as Pool;
  const a=await saveCommercial(pool,'admin',{name:'A fictif',active:true}),b=await saveCommercial(pool,'admin',{name:'B fictif',active:true});
  await setCommercialCredentials(pool,'admin',a.id,{login:'cash.owner',password:'mot de passe fictif'});await setCommercialCredentials(pool,'admin',b.id,{login:'cash.actor',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour les tests',sa=await loginCommercial(pool,secret,{login:'cash.owner',password:'mot de passe fictif'}),sb=await loginCommercial(pool,secret,{login:'cash.actor',password:'mot de passe fictif'});assert.ok(sa&&sb);
  const auth={secret,token:sa.token,enforceMode:true,creditAware:true},actor={kind:'commercial' as const,secret,token:sb.token},day='2026-11-08',at=`${day}T09:00:00.000Z`,clientId=randomUUID(),saleId=randomUUID(),invoiceId=randomUUID();
  await db.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[clientId,'Fictif',1000000]);
  const sale={createdAt:at,clientId,clientName:'Fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Huile',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},auth);
  const invoice={id:invoiceId,clientId,clientName:'Fictif',journalDate:day,createdAt:at,sector:'',amount:600000};await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',auth);
  const receipt={id:randomUUID(),preInvoiceId:invoiceId,clientId,journalDate:day,createdAt:`${day}T10:00:00.000Z`,prePaid:250000,oldDebtPaid:400000,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1000000};await storeJournalSnapshot(pool,{operationId:randomUUID(),version:2,invoice,receipts:[receipt]},'identified',auth);
  await storePrototypeCreditNote(pool,{operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:`${day}T11:00:00.000Z`,choice:'refund'},actor);
  await storePrototypePreInvoiceCredit(pool,{operationId:randomUUID(),invoiceId,expectedVersion:2,recordedAt:`${day}T11:01:00.000Z`,choice:'refund'},actor);
  const owner=await readPrototypeCreditJournal(pool,a.id,day),author=await readPrototypeCreditJournal(pool,b.id,day);
  assert.equal(owner.creditNoteTotal,719000);assert.equal(owner.creditRefundTotal,0);assert.equal(owner.creditCashEvents.length,0);assert.equal(owner.rows[0].oldDebtPaid,400000);assert.equal(owner.collectedAfterRefunds,700000);
  assert.equal(author.creditNoteTotal,0);assert.equal(author.creditRefundTotal,300000);assert.equal(author.creditCashEvents.length,2);assert.equal(author.collectedAfterRefunds,-300000);
  assert.deepEqual(author.creditCashEvents.map(e=>e.kind).sort(),['preinvoice','sale']);assert.equal(owner.creditRefundUnassignedTotal,0);
 }finally{await db.close();}
});
