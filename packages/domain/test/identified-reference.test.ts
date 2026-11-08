import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {readIdentifiedReference,ReferenceOverlap} from '../../../apps/api/src/identified-reference.js';
import {readIdentifiedJournalDay} from '../../../apps/api/src/identified-journal-day.js';

test('projection v4 isolée : combine les soldes et refuse les doublons entre espaces',async()=>{
 const db=new PGlite();
 try {
  await db.exec(schemaSql);await db.exec(schemaSql);
  const conn={query:(sql:string,params?:unknown[])=>db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>conn,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  const client=randomUUID(),commercial=randomUUID(),legacySale=randomUUID(),newSale=randomUUID(),invoiceId=randomUUID(),article=randomUUID();
  await db.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[client,'Client fictif',1000000]);
  await db.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercial,'Commercial fictif']);
  await db.query('INSERT INTO articles(id,code,name,purchase_ttc,sale_ttc) VALUES($1,$2,$3,$4,$5)',[article,'A','Article fictif',100,200]);
  await db.query('INSERT INTO demo_sale_events(operation_id,sale_id,version,client_id,payload,payload_hash) VALUES($1,$2,1,$3,$4::jsonb,$5)',[randomUUID(),legacySale,client,JSON.stringify({sale:{total:119000,paid:0}}),'hash']);
  await db.query('INSERT INTO identified_sale_events(operation_id,sale_id,version,client_id,commercial_id,journal_date,payload,payload_hash) VALUES($1,$2,1,$3,$4,$5,$6::jsonb,$7)',[randomUUID(),newSale,client,commercial,'2026-11-10',JSON.stringify({sale:{clientId:client,clientName:'Client fictif',total:250000,paid:0}}),'hash']);
  const paymentId=randomUUID();
  await db.query('INSERT INTO identified_settlements(operation_id,client_id,commercial_id,journal_date,payload,payload_hash) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[paymentId,client,commercial,'2026-11-10',JSON.stringify({settlement:{amount:30000}}),'hash']);
  const invoice={id:invoiceId,journalDate:'2026-11-10',clientId:client,clientName:'Client fictif',sector:'',amount:600000,createdAt:'2026-11-10T08:00:00.000Z'};
  const receipt={id:randomUUID(),preInvoiceId:invoiceId,clientId:client,journalDate:invoice.journalDate,createdAt:'2026-11-10T09:00:00.000Z',prePaid:200000,oldDebtPaid:300000,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1000000};
  const snapshot={operationId:randomUUID(),version:1,invoice,receipts:[receipt]};
  await db.query('INSERT INTO identified_journal_invoices(id,client_id,journal_date,commercial_id) VALUES($1,$2,$3,$4)',[invoiceId,client,invoice.journalDate,commercial]);
  await db.query('INSERT INTO identified_journal_events(operation_id,invoice_id,commercial_id,version,payload,payload_hash) VALUES($1,$2,$3,1,$4::jsonb,$5)',[snapshot.operationId,invoiceId,commercial,JSON.stringify(snapshot),'hash']);
  const ref=await readIdentifiedReference(pool);assert.equal(ref.version,4);assert.equal(ref.clients[0].serverBalance,'1439000');
  assert.equal(ref.saleStates.length,2);assert.equal(ref.journalStates[0].receipts[0].id,receipt.id);assert.equal(ref.settlementStates[0].operationId,paymentId);
  assert.equal('purchase_ttc' in ref.articles[0],false);assert.equal('purchaseTtc' in ref.articles[0],false);
  const day=await readIdentifiedJournalDay(pool,commercial,'2026-11-10');
  assert.equal(day.rows[0].preInvoiceTotal,600000);assert.equal(day.rows[0].tourTotal,250000);assert.equal(day.rows[0].totalClient,850000);
  assert.equal(day.journalCollected,500000);assert.equal(day.globalSettlementTotal,30000);assert.equal(day.totalCollected,530000);
  assert.equal(day.closure.status,'open');assert.equal(day.closure.version,0);
  const other=randomUUID();await db.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[other,'Autre fictif']);
  await db.query('INSERT INTO identified_sale_events(operation_id,sale_id,version,client_id,commercial_id,journal_date,payload,payload_hash) VALUES($1,$2,2,$3,$4,$5,$6::jsonb,$7)',[randomUUID(),newSale,client,other,'2026-11-10',JSON.stringify({sale:{clientId:client,clientName:'Client fictif',total:250000,paid:0}}),'hash']);
  assert.equal((await readIdentifiedJournalDay(pool,commercial,'2026-11-10')).rows[0].tourTotal,250000);
  assert.equal((await readIdentifiedJournalDay(pool,other,'2026-11-10')).rows.length,0);

  // Même vente présente dans les deux espaces : refuser, pas doubler le solde.
  const duplicateOp=randomUUID();
  await db.query('INSERT INTO identified_sale_events(operation_id,sale_id,version,client_id,commercial_id,journal_date,payload,payload_hash) VALUES($1,$2,1,$3,$4,$5,$6::jsonb,$7)',[duplicateOp,legacySale,client,commercial,'2026-11-10',JSON.stringify({sale:{total:119000,paid:0}}),'hash']);
  await assert.rejects(readIdentifiedReference(pool),ReferenceOverlap);
  await db.query('DELETE FROM identified_sale_events WHERE operation_id=$1',[duplicateOp]);
  // Factures différentes mais même client/date : rapprochement manuel nécessaire.
  const oldInvoiceId=randomUUID(),oldInvoice={...invoice,id:oldInvoiceId},oldEvent={operationId:randomUUID(),version:1,invoice:oldInvoice,receipts:[]};
  await db.query('INSERT INTO sync_journal_invoices(id,client_id,journal_date) VALUES($1,$2,$3)',[oldInvoiceId,client,invoice.journalDate]);
  await db.query('INSERT INTO sync_journal_events(operation_id,invoice_id,version,payload,payload_hash) VALUES($1,$2,1,$3::jsonb,$4)',[oldEvent.operationId,oldInvoiceId,JSON.stringify(oldEvent),'hash']);
  await assert.rejects(readIdentifiedReference(pool),/client\/jour/);
  await db.query('DELETE FROM sync_journal_events WHERE operation_id=$1',[oldEvent.operationId]);
  // Une opération réutilisée entre catégories est également bloquée.
  await db.query('INSERT INTO demo_settlements(operation_id,client_id,payload,payload_hash) VALUES($1,$2,$3::jsonb,$4)',[paymentId,client,JSON.stringify({settlement:{amount:30000}}),'hash']);
  await assert.rejects(readIdentifiedReference(pool),/Opération/);
 } finally {await db.close();}
});

test('référence mobile individuelle : valide la v4 et refuse une régression de cache',async()=>{
 const {validateIdentifiedReference,assertNoReferenceDowngrade}=await import('../../../apps/mobile/identified-reference.js');
 const value={version:4,clients:[{id:'client',name:'Fictif',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'0'}],articles:[],saleStates:[],settlementStates:[],journalStates:[{id:'facture',clientId:'client',journalDate:'2026-11-10',total:1000,receipts:[]}],journalProofs:[{id:'facture',version:1,hash:'a'.repeat(64)}]};
 assert.equal(validateIdentifiedReference(value).version,4);
 assert.throws(()=>validateIdentifiedReference({...value,version:3}));
 assert.throws(()=>validateIdentifiedReference({...value,journalStates:[{...value.journalStates[0],journalDate:undefined}]}),/Dates/);
 assert.throws(()=>validateIdentifiedReference({...value,journalStates:[value.journalStates[0],{...value.journalStates[0],id:'autre'}]}),/dupliquée/);
 assertNoReferenceDowngrade(3,4);assertNoReferenceDowngrade(4,4);assert.throws(()=>assertNoReferenceDowngrade(4,3),/ancienne/);
});
