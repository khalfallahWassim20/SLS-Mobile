import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {creditNotePrototypeSchema,storePrototypeCreditNote} from '../../../apps/api/src/credit-note-registry-prototype.js';
import {preInvoiceCreditPrototypeSchema,storePrototypePreInvoiceCredit} from '../../../apps/api/src/pre-invoice-credit-registry-prototype.js';
import {readPrototypeCreditReference} from '../../../apps/api/src/credit-note-reference-prototype.js';
import {readIdentifiedReference} from '../../../apps/api/src/identified-reference.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {storeIdentifiedSale} from '../../../apps/api/src/identified-operations.js';
import {storeJournalSnapshot} from '../../../apps/api/src/journal-store.js';
import {validatePrototypeCreditReference} from '../../../apps/mobile/credit-note-reference-prototype.js';
import {validateIdentifiedReference} from '../../../apps/mobile/identified-reference.js';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {creditReferencePrototypeSchema,savePrototypeCreditReference,readPrototypeCreditReferenceCache} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';

test('projection intégrée isolée : soldes, crédits, factures et refus en cas de corruption',async()=>{
 const db=new PGlite();try{
  await db.exec(schemaSql);await db.exec(creditNotePrototypeSchema);await db.exec(preInvoiceCreditPrototypeSchema);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={query:(sql:string,params?:unknown[])=>db.query(sql,params),connect:async()=>conn} as unknown as Pool;
  const c=await saveCommercial(pool,'admin',{name:'Fictif',active:true}),secret='secret fictif assez long pour le test';
  await setCommercialCredentials(pool,'admin',c.id,{login:'credit.test',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'credit.test',password:'mot de passe fictif'});assert.ok(session);
  const clientId=randomUUID(),saleId=randomUUID(),invoiceId=randomUUID(),at='2026-11-08T09:00:00.000Z',day='2026-11-08';
  await db.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[clientId,'Client fictif',1000000]);
  const auth={secret,token:session.token},principal={kind:'commercial' as const,...auth};
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},auth);
  const invoice={id:invoiceId,clientId,clientName:'Client fictif',journalDate:day,createdAt:at,sector:'',amount:600000};
  await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',auth);
  const r1={id:randomUUID(),preInvoiceId:invoiceId,clientId,journalDate:day,createdAt:'2026-11-08T10:00:00.000Z',prePaid:200000,oldDebtPaid:300000,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1000000};
  const r2={...r1,id:randomUUID(),createdAt:'2026-11-08T11:00:00.000Z',prePaid:50000,oldDebtPaid:100000};
  await storeJournalSnapshot(pool,{operationId:randomUUID(),version:2,invoice,receipts:[r1]},'identified',auth);
  await storeJournalSnapshot(pool,{operationId:randomUUID(),version:3,invoice,receipts:[r1,r2]},'identified',auth);
  const saleCommand={operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:'2026-11-08T12:00:00.000Z',choice:'refund'};
  const preCommand={operationId:randomUUID(),invoiceId,expectedVersion:3,recordedAt:'2026-11-08T12:00:00.000Z',choice:'credit'};
  await storePrototypeCreditNote(pool,saleCommand,principal);await storePrototypePreInvoiceCredit(pool,preCommand,principal);
  // La référence actuelle reste inchangée : la nouvelle projection est strictement isolée.
  assert.equal((await readIdentifiedReference(pool,true)).clients[0].serverBalance,'1019000');
  const result=await readPrototypeCreditReference(pool);
  assert.equal(result.experimental,true);assert.equal(result.version,5);assert.equal(result.clients[0].serverBalance,'350000');
  const cache=new DatabaseSync(':memory:');
  try {
   cache.exec(`${identifiedDeviceSchema}${creditReferencePrototypeSchema}${creditReferencePrototypeSchema}`);
   const identity={commercialId:c.id,serverOrigin:'https://example.test'};
   cache.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(c.id,identity.serverOrigin);
   const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>cache.prepare(sql).get(...args) as T||null,runAsync:async(sql:string,...args:(string|number|null)[])=>{cache.prepare(sql).run(...args)}};
   await savePrototypeCreditReference(tx,identity,identity,result);
   assert.equal((await readPrototypeCreditReferenceCache(tx,identity))?.clients[0].serverBalance,'350000');
   await assert.rejects(savePrototypeCreditReference(tx,identity,{...identity,serverOrigin:'https://other.test'},result),/Session/);
   const previousSale={...result.saleStates[0],version:1,total:'119000',paid:'50000',cancelled:false,creditNote:null};
   await assert.rejects(savePrototypeCreditReference(tx,identity,identity,{...result,saleStates:[previousSale]}),/périmée/);
   await assert.rejects(savePrototypeCreditReference(tx,identity,identity,{...result,journalStates:[{...result.journalStates[0],creditNote:null}]}),/périmée/);
   assert.equal((await readPrototypeCreditReferenceCache(tx,identity))?.clients[0].serverBalance,'350000');
  } finally {cache.close();}
  const mobile=validatePrototypeCreditReference(result);assert.equal(mobile.clients[0].serverBalance,'350000');assert.equal(mobile.saleStates[0].creditNote?.refund,50000);assert.equal(mobile.journalStates[0].creditNote?.choice,'credit');
  assert.throws(()=>validateIdentifiedReference(result),/invalide/);
  assert.throws(()=>validatePrototypeCreditReference({...result,saleStates:[{...result.saleStates[0],paid:'1000'}]}),/incohérent/);
  assert.throws(()=>validatePrototypeCreditReference({...result,journalStates:[{...result.journalStates[0],version:2}]}),/Version/);
  assert.throws(()=>validatePrototypeCreditReference({...result,journalStates:[{...result.journalStates[0],creditNote:{...result.journalStates[0].creditNote!,operationId:saleCommand.operationId}}]}),/dupliqué/);
  assert.equal(result.saleStates[0].total,'0');assert.equal(result.saleStates[0].paid,'0');assert.equal(result.saleStates[0].version,2);assert.equal(result.saleStates[0].cancelled,true);
  assert.equal(result.journalStates[0].creditNote?.operationId,preCommand.operationId);assert.equal(result.journalStates[0].version,3);
  assert.equal(result.journalStates[0].receipts[0].oldDebtPaid,300000);assert.equal(result.journalStates[0].receipts[1].oldDebtPaid,100000);
  await db.query("UPDATE pre_invoice_credit_prototype_movements SET balance_delta=1 WHERE operation_id=$1 AND kind='invoice_cancellation'",[preCommand.operationId]);
  await assert.rejects(readPrototypeCreditReference(pool),/Mouvements/);
  await db.query("UPDATE pre_invoice_credit_prototype_movements SET balance_delta=-600000 WHERE operation_id=$1 AND kind='invoice_cancellation'",[preCommand.operationId]);
  const r3={...r2,id:randomUUID(),createdAt:'2026-11-08T13:00:00.000Z',prePaid:10000,oldDebtPaid:0};
  // Simule une corruption directe en base, sans passer par le chemin protégé.
  await db.query('INSERT INTO identified_journal_events(operation_id,invoice_id,commercial_id,version,payload,payload_hash) VALUES($1,$2,$3,4,$4::jsonb,$5)',[randomUUID(),invoiceId,c.id,JSON.stringify({operationId:randomUUID(),version:4,invoice,receipts:[r1,r2,r3]}),'corruption']);
  await assert.rejects(readPrototypeCreditReference(pool),/modifiée après avoir/);
 }finally{await db.close();}
});
