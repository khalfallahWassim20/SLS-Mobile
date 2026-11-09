import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {creditNotePrototypeSchema,storePrototypeCreditNote} from '../../../apps/api/src/credit-note-registry-prototype.js';
import {preInvoiceCreditPrototypeSchema,storePrototypePreInvoiceCredit} from '../../../apps/api/src/pre-invoice-credit-registry-prototype.js';
import {readPrototypeCreditReference} from '../../../apps/api/src/credit-note-reference-prototype.js';
import {readPrototypeCreditHistory} from '../../../apps/api/src/credit-note-history-prototype.js';
import {readPrototypeCreditJournal} from '../../../apps/api/src/credit-note-journal-prototype.js';
import {readIdentifiedReference} from '../../../apps/api/src/identified-reference.js';
import {readIdentifiedJournalDay} from '../../../apps/api/src/identified-journal-day.js';
import {readServerJournalDay} from '../../../apps/api/src/journal-day.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {storeIdentifiedSale} from '../../../apps/api/src/identified-operations.js';
import {storeJournalSnapshot} from '../../../apps/api/src/journal-store.js';
import {validatePrototypeCreditReference,activePrototypeClients} from '../../../apps/mobile/credit-note-reference-prototype.js';
import {validateIdentifiedReference} from '../../../apps/mobile/identified-reference.js';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {creditReferencePrototypeSchema,savePrototypeCreditReference,readPrototypeCreditReferenceCache} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {prototypeCreditBalance} from '../../../apps/mobile/credit-note-balance-prototype.js';
import {offlineCreditPrototypeSchema,prepareOfflineCreditPrototype,type Note} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {readPrototypeCreditBalance,prepareBalancedLocalCredit} from '../../../apps/mobile/credit-note-balance-storage-prototype.js';
import {describeCreditReview} from '../../../apps/mobile/credit-note-review-display.js';
import {previewLocalCredit,confirmLocalCreditReview} from '../../../apps/mobile/credit-note-review-prototype.js';
import {tourCloseQueueSchema} from '../../../apps/mobile/tour-close-queue.js';
import {assertNoRemoteCreditNote} from '../../../apps/mobile/credit-note-local-guard.js';
import {saveVerifiedCreditReference} from '../../../apps/mobile/credit-note-sync-reference.js';

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
  const otherClient=randomUUID();await db.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[otherClient,'Z autre client fictif',42000]);
  const auth={secret,token:session.token},principal={kind:'commercial' as const,...auth};
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},auth);
  const invoice={id:invoiceId,clientId,clientName:'Client fictif',journalDate:day,createdAt:at,sector:'',amount:600000};
  await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',auth);
  const r1={id:randomUUID(),preInvoiceId:invoiceId,clientId,journalDate:day,createdAt:'2026-11-08T10:00:00.000Z',prePaid:200000,oldDebtPaid:300000,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1000000};
  const r2={...r1,id:randomUUID(),createdAt:'2026-11-08T11:00:00.000Z',prePaid:50000,oldDebtPaid:100000};
  await storeJournalSnapshot(pool,{operationId:randomUUID(),version:2,invoice,receipts:[r1]},'identified',auth);
  await storeJournalSnapshot(pool,{operationId:randomUUID(),version:3,invoice,receipts:[r1,r2]},'identified',auth);
  const saleCommand={operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:'2026-11-08T12:00:00.000Z',choice:'refund' as const};
  const preCommand={operationId:randomUUID(),invoiceId,expectedVersion:3,recordedAt:'2026-11-08T12:00:00.000Z',choice:'credit' as const};
  const before=validatePrototypeCreditReference(await readPrototypeCreditReference(pool));
  const saleResult=await storePrototypeCreditNote(pool,saleCommand,principal),preResult=await storePrototypePreInvoiceCredit(pool,preCommand,principal);
  // L’ancienne référence ne doit jamais masquer les avoirs existants.
  await assert.rejects(readIdentifiedReference(pool,true),/avoirs existent/);
  await assert.rejects(readIdentifiedJournalDay(pool,c.id,day),/avoirs existent/);
  await assert.rejects(readServerJournalDay(pool,day,'combined'),/avoirs existent/);
  const history=await readPrototypeCreditHistory(pool);
  assert.equal(history.length,2);
  assert.deepEqual(history.find(x=>x.kind==='sale'),{kind:'sale',operationId:saleCommand.operationId,invoiceId:saleId,invoiceDay:day,recordedAt:saleCommand.recordedAt,recordedDay:day,clientId,clientName:'Client fictif',ownerId:c.id,actor:{id:c.id,role:'commercial'},version:1,invoiceTotal:119000,netPaid:50000,oldDebtPaid:0,wasDeclared:true,refund:50000,retainedCredit:0,balanceDelta:-69000});
  assert.deepEqual(history.find(x=>x.kind==='preinvoice'),{kind:'preinvoice',operationId:preCommand.operationId,invoiceId,invoiceDay:day,recordedAt:preCommand.recordedAt,recordedDay:day,clientId,clientName:'Client fictif',ownerId:c.id,actor:{id:c.id,role:'commercial'},version:3,invoiceTotal:600000,netPaid:250000,oldDebtPaid:400000,wasDeclared:true,refund:0,retainedCredit:250000,balanceDelta:-600000});
  const journal=await readPrototypeCreditJournal(pool,c.id,day);
  assert.equal(journal.totalBilled,719000);assert.equal(journal.totalCollected,700000);
  assert.equal(journal.creditNoteTotal,719000);assert.equal(journal.creditRefundTotal,50000);assert.equal(journal.creditRetainedTotal,250000);
  assert.equal(journal.billedAfterCredits,0);assert.equal(journal.collectedAfterRefunds,650000);
  assert.equal(journal.rows[0].oldDebtPaid,400000);assert.equal(journal.rows[0].preInvoiceCancelled,true);assert.equal(journal.rows[0].cancelledSaleCount,1);
  const nextDay=await readPrototypeCreditJournal(pool,c.id,'2026-11-09');assert.equal(nextDay.creditEvents.length,0);assert.equal(nextDay.billedAfterCredits,0);
  const result=await readPrototypeCreditReference(pool);
  assert.equal(result.experimental,true);assert.equal(result.version,5);assert.equal(result.clients[0].serverBalance,'350000');
  const cache=new DatabaseSync(':memory:');
  try {
   cache.exec(`${identifiedDeviceSchema}${creditReferencePrototypeSchema}${creditReferencePrototypeSchema}`);
   const identity={commercialId:c.id,serverOrigin:'https://example.test'};
   cache.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(c.id,identity.serverOrigin);
   const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>cache.prepare(sql).get(...args) as T||null,runAsync:async(sql:string,...args:(string|number|null)[])=>{cache.prepare(sql).run(...args)}};
   // Deuxième appareil : la transition vers une annulation distante est
   // acceptée, mais une source modifiée à version identique est refusée.
   await savePrototypeCreditReference(tx,identity,identity,before);
   await assert.rejects(savePrototypeCreditReference(tx,identity,identity,{...before,eligibleSaleProofs:before.eligibleSaleProofs.map(p=>p.saleId===saleId?{...p,hash:'0'.repeat(64)}:p)}),/Preuve de source/);
   await assert.rejects(savePrototypeCreditReference(tx,identity,identity,{...result,journalProofs:result.journalProofs.map(p=>p.id===invoiceId?{...p,hash:'0'.repeat(64)}:p)}),/Preuve de préétablie/);
   await savePrototypeCreditReference(tx,identity,identity,result);
   assert.equal((await readPrototypeCreditReferenceCache(tx,identity))?.clients[0].serverBalance,'350000');
   await assert.rejects(savePrototypeCreditReference(tx,identity,{...identity,serverOrigin:'https://other.test'},result),/Session/);
   const previousSale={...result.saleStates[0],version:1,total:'119000',paid:'50000',cancelled:false,creditNote:null};
   await assert.rejects(savePrototypeCreditReference(tx,identity,identity,{...result,saleStates:[previousSale],saleProofs:[]}),/périmée/);
   await assert.rejects(savePrototypeCreditReference(tx,identity,identity,{...result,journalStates:[{...result.journalStates[0],creditNote:null}]}),/périmée/);
   await assert.rejects(savePrototypeCreditReference(tx,identity,identity,{...result,saleProofs:[{...result.saleProofs[0],hash:'0'.repeat(64)}]}),/Preuve/);
   await assert.rejects(savePrototypeCreditReference(tx,identity,identity,{...result,journalProofs:result.journalProofs.map(p=>p.id===invoiceId?{...p,hash:'0'.repeat(64)}:p)}),/Preuve de préétablie/);
   assert.equal((await readPrototypeCreditReferenceCache(tx,identity))?.clients[0].serverBalance,'350000');
   // Les clients désactivés restent dans le référentiel pour réconcilier les
   // opérations et preuves, mais ne sont plus proposés pour une nouvelle vente.
   await db.query('UPDATE clients SET active=false WHERE id=$1',[clientId]);
   const inactive=validatePrototypeCreditReference(await readPrototypeCreditReference(pool,false));
   assert.equal(inactive.clients.find(x=>x.id===clientId)?.active,false);
   assert.equal(inactive.clients.find(x=>x.id===clientId)?.statusRevision,'2');
   assert.ok(!activePrototypeClients(inactive).some(x=>x.id===clientId));
   await savePrototypeCreditReference(tx,identity,identity,inactive);
   assert.equal((await readPrototypeCreditReferenceCache(tx,identity))?.clients[0].serverBalance,'350000');
   await assert.rejects(savePrototypeCreditReference(tx,identity,identity,result),/Statut client périmé/);
   await assert.rejects(savePrototypeCreditReference(tx,identity,identity,{...inactive,clients:inactive.clients.map(c=>c.id===clientId?{...c,active:true}:c)}),/Statut client périmé/);
   await db.query('UPDATE clients SET active=true WHERE id=$1',[clientId]);
   const activeAgain=validatePrototypeCreditReference(await readPrototypeCreditReference(pool,false));
   assert.equal(activeAgain.clients.find(x=>x.id===clientId)?.statusRevision,'3');
   assert.ok(activePrototypeClients(activeAgain).some(x=>x.id===clientId));
   await savePrototypeCreditReference(tx,identity,identity,activeAgain);
   await assert.rejects(savePrototypeCreditReference(tx,identity,identity,inactive),/Statut client périmé/);
  } finally {cache.close();}
  const mobile=validatePrototypeCreditReference(result);assert.equal(mobile.clients[0].serverBalance,'350000');
  const origin='https://example.test';
  const localSale:Note={kind:'sale',commercialId:c.id,serverOrigin:origin,command:saleCommand,source:sale,balanceDelta:saleResult.event.balanceDelta,refund:saleResult.event.refund,retainedCredit:saleResult.event.retainedCredit};
  const localPre:Note={kind:'preinvoice',commercialId:c.id,serverOrigin:origin,command:preCommand,source:preResult.event.source,balanceDelta:preResult.event.balanceDelta,refund:preResult.event.refund,retainedCredit:preResult.event.retainedCredit};
  const localJournal={id:invoiceId,clientId,journalDate:day,version:3,total:600000,receipts:[r1,r2],snapshot:preResult.event.source};
  const current={clientId,identity:{commercialId:c.id,serverOrigin:origin},sales:[{...sale,id:1}],journals:[localJournal],settlements:[],notes:[localSale,localPre]};
  assert.deepEqual(prototypeCreditBalance({...current,reference:before}),{balance:350000,conflict:false});
  assert.deepEqual(prototypeCreditBalance({...current,reference:mobile}),{balance:350000,conflict:false});
  assert.deepEqual(prototypeCreditBalance({...current,sales:[],journals:[],notes:[],reference:mobile}),{balance:350000,conflict:false});
  assert.deepEqual(prototypeCreditBalance({...current,clientId:otherClient,reference:mobile}),{balance:42000,conflict:false});
  assert.deepEqual(prototypeCreditBalance({...current,reference:mobile,sales:[...current.sales,{id:2,clientId,total:200,paid:50}],settlements:[{clientId,amount:25}]}),{balance:350125,conflict:false});
  assert.throws(()=>prototypeCreditBalance({...current,sales:[],reference:mobile}),/introuvable/);
  assert.throws(()=>prototypeCreditBalance({...current,notes:[localSale,{...localPre,command:{...localPre.command,operationId:localSale.command.operationId}}],reference:mobile}),/dupliqué/);
  // Lecture des vraies tables SQLite au même instant que le cache serveur.
  const localDb=new DatabaseSync(':memory:');
  try {
   localDb.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
    CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
    CREATE TABLE sales_outbox(sale_id TEXT);CREATE TABLE journal_sync_outbox(invoice_id TEXT);
    CREATE TABLE tour_pre_invoices(id TEXT PRIMARY KEY,client_id TEXT,journal_date TEXT,payload TEXT);
    CREATE TABLE tour_journal_receipts(id TEXT PRIMARY KEY,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);
    CREATE TABLE journal_sync_state(invoice_id TEXT PRIMARY KEY,version INTEGER,payload TEXT);
    ${identifiedDeviceSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${tourCloseQueueSchema}`);
   const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>localDb.prepare(sql).get(...args) as T||null,
    getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>localDb.prepare(sql).all(...args) as T[],
    runAsync:async(sql:string,...args:(string|number|null)[])=>{localDb.prepare(sql).run(...args)}};
   const identity=current.identity;
   localDb.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(c.id,origin);
   await assert.rejects(readPrototypeCreditBalance(tx,identity,clientId),/indisponible/);
   await savePrototypeCreditReference(tx,identity,identity,before);
   localDb.prepare('INSERT INTO sales VALUES(?,?,?)').run(1,clientId,JSON.stringify(sale));
   localDb.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(invoiceId,clientId,day,JSON.stringify(invoice));
   for(const receipt of [r1,r2])localDb.prepare('INSERT INTO tour_journal_receipts VALUES(?,?,?,?,?)').run(receipt.id,invoiceId,clientId,day,JSON.stringify(receipt));
   localDb.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(invoiceId,3,JSON.stringify(preResult.event.source));
   localDb.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(randomUUID(),c.id,'sale',saleId,at);
   localDb.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(randomUUID(),c.id,'journal',invoiceId,at);
   // La création refusée revient entièrement en arrière, puis les deux avoirs
   // sont calculés et enregistrés dans la même transaction que leurs soldes.
   localDb.exec('BEGIN');await assert.rejects(prepareBalancedLocalCredit(tx,identity,otherClient,'sale',saleCommand),/Client/);localDb.exec('ROLLBACK');
   assert.equal(localDb.prepare('SELECT count(*) AS n FROM offline_credit_prototype').get()?.n,0);
   const sha=async(value:string)=>createHash('sha256').update(value).digest('hex');
   // Sur un autre appareil, une facture identifiée peut être annulée sans
   // opération locale seulement avec la preuve exacte et sans file en attente.
   localDb.exec('BEGIN');localDb.prepare('DELETE FROM identified_local_operations').run();
   const secondIdentity={...identity,commercialId:randomUUID()};
   localDb.prepare('UPDATE identified_device SET commercial_id=?').run(secondIdentity.commercialId);
   localDb.prepare('UPDATE credit_reference_prototype_cache SET commercial_id=?').run(secondIdentity.commercialId);
   const remoteSale=await previewLocalCredit(tx,secondIdentity,clientId,'sale',{...saleCommand,operationId:randomUUID()},sha);
   const remotePre=await previewLocalCredit(tx,secondIdentity,clientId,'preinvoice',{...preCommand,operationId:randomUUID()},sha);
   assert.equal(remoteSale.afterBalance,950000);assert.equal(remotePre.afterBalance,419000);
   localDb.prepare('INSERT INTO sales_outbox VALUES(?)').run(saleId);
   await assert.rejects(previewLocalCredit(tx,secondIdentity,clientId,'sale',{...saleCommand,operationId:randomUUID()},sha),/preuve serveur/);
   localDb.prepare('DELETE FROM sales_outbox').run();localDb.prepare('INSERT INTO journal_sync_outbox VALUES(?)').run(invoiceId);
   await assert.rejects(previewLocalCredit(tx,secondIdentity,clientId,'preinvoice',{...preCommand,operationId:randomUUID()},sha),/preuve serveur/);
   localDb.prepare('DELETE FROM journal_sync_outbox').run();
   localDb.prepare('UPDATE sales SET payload=? WHERE id=1').run(JSON.stringify({...sale,lines:[{...sale.lines[0],name:'Source différente'}]}));
   await assert.rejects(previewLocalCredit(tx,secondIdentity,clientId,'sale',{...saleCommand,operationId:randomUUID()},sha),/preuve serveur/);
   localDb.exec('ROLLBACK');
   // Les aperçus appliquent les mêmes règles sans écrire d'avoir : deux choix
   // affichent bien les effets distincts et la dette ancienne reste intacte.
   localDb.exec('BEGIN');
   await assert.rejects(previewLocalCredit(tx,identity,clientId,'sale',{...saleCommand,operationId:randomUUID(),choice:null},sha),/Choisissez/);
   assert.equal(localDb.prepare('SELECT count(*) AS n FROM offline_credit_prototype').get()?.n,0);
   const saleReview=await previewLocalCredit(tx,identity,clientId,'sale',{...saleCommand,operationId:randomUUID()},sha);
   const saleCreditReview=await previewLocalCredit(tx,identity,clientId,'sale',{...saleCommand,operationId:randomUUID(),choice:'credit'},sha);
   assert.equal(saleReview.beforeBalance,1019000);assert.equal(saleReview.afterBalance,950000);assert.equal(saleReview.refund,50000);
   assert.equal(describeCreditReview(saleReview).clientName,'Client fictif');assert.equal(describeCreditReview(saleReview).oldDebtPaid,0);
   assert.throws(()=>describeCreditReview({...saleReview,afterBalance:0}),/incohérent/);
   assert.equal(saleCreditReview.afterBalance,900000);assert.equal(saleCreditReview.retainedCredit,50000);
   assert.equal(localDb.prepare('SELECT count(*) AS n FROM offline_credit_prototype').get()?.n,0);localDb.exec('COMMIT');
   // La modification d'une source ou du solde après l'aperçu invalide la
   // confirmation : la transaction ne conserve aucun avoir.
   localDb.exec('BEGIN');localDb.prepare('UPDATE sales SET payload=? WHERE id=1').run(JSON.stringify({...sale,lines:[{...sale.lines[0],name:'Changement'}]}));
   await assert.rejects(confirmLocalCreditReview(tx,identity,saleReview,saleCommand,sha),/modifié/);localDb.exec('ROLLBACK');
   assert.equal(localDb.prepare('SELECT count(*) AS n FROM offline_credit_prototype').get()?.n,0);
   localDb.exec('BEGIN');localDb.prepare('INSERT INTO settlements VALUES(1,?,?)').run(clientId,JSON.stringify({clientId,amount:100}));
   await assert.rejects(confirmLocalCreditReview(tx,identity,saleReview,saleCommand,sha),/modifié/);localDb.exec('ROLLBACK');
   localDb.exec('BEGIN');await assert.rejects(confirmLocalCreditReview(tx,identity,saleReview,{...saleCommand,recordedAt:'2026-11-09T12:00:00.000Z'},sha),/périmé/);localDb.exec('ROLLBACK');
   localDb.exec('BEGIN');await assert.rejects(confirmLocalCreditReview(tx,identity,saleReview,{...saleCommand,choice:'credit'},sha),/périmé/);localDb.exec('ROLLBACK');
   localDb.exec('BEGIN');const createdSale=await confirmLocalCreditReview(tx,identity,saleReview,saleCommand,sha);assert.equal(createdSale.balance,950000);localDb.exec('COMMIT');
   localDb.exec('BEGIN');const preReview=await previewLocalCredit(tx,identity,clientId,'preinvoice',{...preCommand,operationId:randomUUID()},sha);
   assert.equal(preReview.afterBalance,350000);assert.equal(preReview.retainedCredit,250000);assert.equal((preReview.source as any).receipts[1].oldDebtPaid,100000);
   const display=describeCreditReview(preReview);assert.equal(display.paid,250000);assert.equal(display.oldDebtPaid,400000);assert.equal(display.retainedCredit,250000);
   assert.equal(localDb.prepare('SELECT count(*) AS n FROM offline_credit_prototype').get()?.n,1);
   const createdPre=await confirmLocalCreditReview(tx,identity,preReview,preCommand,sha);assert.equal(createdPre.balance,350000);localDb.exec('COMMIT');
   assert.deepEqual(createdSale.note,localSale);assert.deepEqual(createdPre.note,localPre);
   localDb.exec('BEGIN');assert.deepEqual(await readPrototypeCreditBalance(tx,identity,clientId),{balance:350000,conflict:false});localDb.exec('COMMIT');
   // Une référence d'avant l'accusé ne doit pas effacer les preuves déjà reçues.
   localDb.prepare('UPDATE offline_credit_prototype SET pending=0').run();
   await assert.rejects(saveVerifiedCreditReference(tx,identity,identity,before,sha),/déjà confirmé/);
   assert.equal((await readPrototypeCreditReferenceCache(tx,identity))?.clients[0].serverBalance,'1019000');
   localDb.prepare('UPDATE offline_credit_prototype SET pending=1 WHERE operation_id=?').run(saleCommand.operationId);
   await assert.rejects(saveVerifiedCreditReference(tx,identity,identity,before,sha),/préétabli déjà confirmé/);
   localDb.prepare('UPDATE offline_credit_prototype SET pending=0 WHERE operation_id=?').run(saleCommand.operationId);
   await saveVerifiedCreditReference(tx,identity,identity,result,sha);
   await assert.rejects(saveVerifiedCreditReference(tx,identity,identity,{...result,saleProofs:[{...result.saleProofs[0],hash:'0'.repeat(64)}]},sha),/déjà confirmé/);
   await assert.rejects(assertNoRemoteCreditNote(tx,identity,'sale',saleId),/annulée/);
   await assert.rejects(assertNoRemoteCreditNote(tx,identity,'preinvoice',invoiceId),/annulée/);
   await assert.rejects(prepareOfflineCreditPrototype(tx,identity,'sale',{...saleCommand,operationId:randomUUID()}),/annulée/);
   await assert.rejects(prepareOfflineCreditPrototype(tx,identity,'preinvoice',{...preCommand,operationId:randomUUID()}),/annulée/);
   await assertNoRemoteCreditNote(tx,identity,'sale',randomUUID());
   localDb.exec('BEGIN');assert.deepEqual(await readPrototypeCreditBalance(tx,identity,clientId),{balance:350000,conflict:false});localDb.exec('COMMIT');
   await assert.rejects(readPrototypeCreditBalance(tx,{...identity,serverOrigin:'https://other.test'},clientId),/identité/i);
   localDb.exec('BEGIN');localDb.prepare('DELETE FROM journal_sync_state').run();await assert.rejects(readPrototypeCreditBalance(tx,identity,clientId),/sans version/);localDb.exec('ROLLBACK');
   localDb.exec('BEGIN');localDb.prepare('UPDATE tour_journal_receipts SET payload=? WHERE id=?').run(JSON.stringify({...r1,oldDebtPaid:1}),r1.id);await assert.rejects(readPrototypeCreditBalance(tx,identity,clientId),/incohérent/);localDb.exec('ROLLBACK');
   localDb.exec('BEGIN');localDb.prepare('DELETE FROM tour_pre_invoices').run();await assert.rejects(readPrototypeCreditBalance(tx,identity,clientId),/sans facture/);localDb.exec('ROLLBACK');
   localDb.exec('BEGIN');localDb.prepare('UPDATE offline_credit_prototype SET payload=? WHERE operation_id=?').run(JSON.stringify({...localSale,refund:0}),saleCommand.operationId);await assert.rejects(readPrototypeCreditBalance(tx,identity,clientId),/Montants/);localDb.exec('ROLLBACK');
   localDb.exec('BEGIN');localDb.prepare('DELETE FROM offline_credit_prototype WHERE operation_id=?').run(saleCommand.operationId);assert.equal((await readPrototypeCreditBalance(tx,identity,clientId)).conflict,true);localDb.exec('ROLLBACK');
   const digest=async(value:string)=>createHash('sha256').update(value).digest('hex');
   // Une annulation provenant d’un autre appareil n'est reconnue que si le
   // contenu complet est identique et qu'aucune écriture ne reste en attente.
   localDb.exec('BEGIN');localDb.prepare('DELETE FROM offline_credit_prototype').run();
   assert.deepEqual(await readPrototypeCreditBalance(tx,identity,clientId,digest),{balance:350000,conflict:false});
   localDb.prepare('INSERT INTO sales_outbox VALUES(?)').run(saleId);
   assert.equal((await readPrototypeCreditBalance(tx,identity,clientId,digest)).conflict,true);
   localDb.prepare('DELETE FROM sales_outbox').run();
   localDb.prepare('INSERT INTO journal_sync_outbox VALUES(?)').run(invoiceId);
   assert.equal((await readPrototypeCreditBalance(tx,identity,clientId,digest)).conflict,true);
   localDb.prepare('DELETE FROM journal_sync_outbox').run();
   // Même montant et version, mais lignes différentes : aucune adoption.
   localDb.prepare('UPDATE sales SET payload=? WHERE id=1').run(JSON.stringify({...sale,lines:[{...sale.lines[0],name:'Autre produit'}]}));
   assert.equal((await readPrototypeCreditBalance(tx,identity,clientId,digest)).conflict,true);
   localDb.prepare('UPDATE sales SET payload=? WHERE id=1').run(JSON.stringify(sale));
   const changed={...r1,mode:'Virement'};
   localDb.prepare('UPDATE tour_journal_receipts SET payload=? WHERE id=?').run(JSON.stringify(changed),r1.id);
   localDb.prepare('UPDATE journal_sync_state SET payload=?').run(JSON.stringify({...preResult.event.source,receipts:[changed,r2]}));
   assert.equal((await readPrototypeCreditBalance(tx,identity,clientId,digest)).conflict,true);
   localDb.exec('ROLLBACK');

  }finally{localDb.close();}

  assert.equal(prototypeCreditBalance({...current,notes:[localPre],reference:mobile}).conflict,true);
  assert.throws(()=>prototypeCreditBalance({...current,sales:[{...sale,id:1,total:1}],reference:mobile}),/modifiée/);assert.equal(mobile.saleStates[0].creditNote?.refund,50000);assert.equal(mobile.journalStates[0].creditNote?.choice,'credit');
  assert.throws(()=>validateIdentifiedReference(result),/invalide/);
  assert.throws(()=>validatePrototypeCreditReference({...result,saleStates:[{...result.saleStates[0],paid:'1000'}]}),/incohérent/);
  assert.throws(()=>validatePrototypeCreditReference({...result,journalStates:[{...result.journalStates[0],version:2}]}),/Version/);
  assert.throws(()=>validatePrototypeCreditReference({...result,journalStates:[{...result.journalStates[0],creditNote:{...result.journalStates[0].creditNote!,operationId:saleCommand.operationId}}]}),/dupliqué/);
  assert.equal(result.saleStates[0].total,'0');assert.equal(result.saleStates[0].paid,'0');assert.equal(result.saleStates[0].version,2);assert.equal(result.saleStates[0].cancelled,true);
  assert.equal(result.journalStates[0].creditNote?.operationId,preCommand.operationId);assert.equal(result.journalStates[0].version,3);
  assert.equal(result.journalStates[0].receipts[0].oldDebtPaid,300000);assert.equal(result.journalStates[0].receipts[1].oldDebtPaid,100000);
  // Une annulation faite par l'admin le lendemain est attribuée à la journée
  // de sa création, tout en conservant la facture sur sa journée d'origine.
  const secondId=randomUUID(),secondSale={...sale,clientId:otherClient,clientName:'Z autre client fictif',syncSaleId:secondId};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId:secondId,version:1,recordedAt:at,sale:secondSale,refund:0},auth);
  const adminCommand={operationId:randomUUID(),invoiceId:secondId,expectedVersion:1,recordedAt:'2026-11-09T10:00:00.000Z',choice:'refund' as const};
  await storePrototypeCreditNote(pool,adminCommand,{kind:'admin',actorId:'admin'});
  const originalDay=await readPrototypeCreditJournal(pool,c.id,day),laterDay=await readPrototypeCreditJournal(pool,c.id,'2026-11-09');
  assert.equal(originalDay.rows.find(r=>r.clientId===otherClient)?.cancelledSaleCount,1);
  assert.equal(laterDay.creditEvents.length,1);assert.equal(laterDay.creditEvents[0].actor.role,'admin');
  assert.equal(laterDay.billedAfterCredits,-119000);assert.equal(laterDay.collectedAfterRefunds,-50000);
  await db.query("UPDATE pre_invoice_credit_prototype_movements SET balance_delta=1 WHERE operation_id=$1 AND kind='invoice_cancellation'",[preCommand.operationId]);
  await assert.rejects(readPrototypeCreditReference(pool),/Mouvements/);
  await assert.rejects(readPrototypeCreditHistory(pool),/Mouvements/);
  await assert.rejects(readPrototypeCreditJournal(pool,c.id,day),/Mouvements/);
  await db.query("UPDATE pre_invoice_credit_prototype_movements SET balance_delta=-600000 WHERE operation_id=$1 AND kind='invoice_cancellation'",[preCommand.operationId]);
  const r3={...r2,id:randomUUID(),createdAt:'2026-11-08T13:00:00.000Z',prePaid:10000,oldDebtPaid:0};
  // Simule une corruption directe en base, sans passer par le chemin protégé.
  await db.query('INSERT INTO identified_journal_events(operation_id,invoice_id,commercial_id,version,payload,payload_hash) VALUES($1,$2,$3,4,$4::jsonb,$5)',[randomUUID(),invoiceId,c.id,JSON.stringify({operationId:randomUUID(),version:4,invoice,receipts:[r1,r2,r3]}),'corruption']);
  await assert.rejects(readPrototypeCreditReference(pool),/modifiée après avoir/);
 }finally{await db.close();}
});
