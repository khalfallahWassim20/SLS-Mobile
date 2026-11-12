import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readLocalSaleCashLedger} from '../../../apps/mobile/credit-sale-refund-journal-prototype.js';
import {describeCreditJournalPrototype} from '../../../apps/mobile/credit-note-journal-view-model-prototype.js';
import {journalCsv,journalHtml} from '../../../apps/mobile/journal-export.js';
import type {SavedSale} from '../../../apps/mobile/storage.js';

test('flux mobile v5 : paiement initial, remboursement sur deux jours et origine distante',async()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(`CREATE TABLE sale_revisions(id INTEGER PRIMARY KEY,sale_id INTEGER,created_at TEXT,previous_payload TEXT,new_payload TEXT,refund INTEGER);
  CREATE TABLE credit_local_sale_reconcile_prototype(revision_id INTEGER,operation_id TEXT,sale_id TEXT,commercial_id TEXT,event TEXT);
  CREATE TABLE identified_local_operations(operation_id TEXT,operation_kind TEXT,entity_id TEXT,commercial_id TEXT,recorded_at TEXT);`);
  const clientId=randomUUID(),saleId=randomUUID(),identity={commercialId:randomUUID(),serverOrigin:'https://example.test'},sale:SavedSale={id:1,createdAt:'2026-11-07T23:30:00.000Z',clientId,clientName:'<Client>',syncSaleId:saleId,syncVersion:2,lines:[],total:11900,paid:11900,remaining:0,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  const prev={...sale,syncVersion:1,total:119000,paid:50000,remaining:69000},at='2026-11-08T23:30:00.000Z',op=randomUUID();
  db.prepare('INSERT INTO sale_revisions VALUES(?,?,?,?,?,?)').run(1,1,at,JSON.stringify(prev),JSON.stringify(sale),38100);
  db.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(randomUUID(),'sale',saleId,identity.commercialId,sale.createdAt);
  db.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(op,'sale',saleId,identity.commercialId,at);
  const tx={getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[],getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).get(...args) as T||null};
  const first=await readLocalSaleCashLedger(tx,identity,[sale],'2026-11-08'),next=await readLocalSaleCashLedger(tx,identity,[sale],'2026-11-09');
  assert.deepEqual(first.initialPayments,[{saleId:1,paid:50000}]);assert.deepEqual(first.refunds,[]);assert.equal(next.refunds[0].refund,38100);assert.deepEqual(next.initialPayments,[]);
  const report={day:'2026-11-08',commercial:'Test',rows:[{clientId,clientName:'<Client>',sector:'',preInvoice:null,sales:[sale],total:11900}],receipts:[],credits:[],saleRefunds:first.refunds,initialSalePayments:first.initialPayments};
  assert.equal(describeCreditJournalPrototype(report).totals.collectedAfterLocalRefunds,50000);
  const later={...report,day:'2026-11-09',rows:[],saleRefunds:next.refunds,initialSalePayments:[]};
  assert.equal(describeCreditJournalPrototype(later).totals.collectedAfterLocalRefunds,-38100);assert.match(journalCsv(later),/-38,100/);assert.match(journalHtml(later),/&lt;Client&gt;/);
  assert.throws(()=>journalCsv({...later,saleRefunds:[next.refunds[0],next.refunds[0]]}),/invalide/);
  // Une date partagée entre plusieurs marqueurs ne prouve pas quelle opération
  // correspond à la révision : ne jamais attribuer une sortie par supposition.
  db.exec('SAVEPOINT ambiguous');db.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(randomUUID(),'sale',saleId,identity.commercialId,at);
  await assert.rejects(readLocalSaleCashLedger(tx,identity,[sale],'2026-11-09'),/ambiguë/);db.exec('ROLLBACK TO ambiguous; RELEASE ambiguous');
  // Une date illisible ne doit pas faire disparaître un remboursement du jour.
  db.exec('SAVEPOINT bad_date');db.prepare('UPDATE sale_revisions SET created_at=?').run('date invalide');
  await assert.rejects(readLocalSaleCashLedger(tx,identity,[sale],'2026-11-09'),/illisible/);db.exec('ROLLBACK TO bad_date; RELEASE bad_date');
  // La même version importée est visible dans l'historique mais ne constitue
  // pas une sortie sur le téléphone créateur.
  const {id:_id,...source}=sale,remoteOp=randomUUID(),remoteActor=randomUUID(),event={operationId:remoteOp,saleId,version:2,recordedAt:at,sale:source,refund:38100};
  db.prepare('INSERT INTO credit_local_sale_reconcile_prototype VALUES(?,?,?,?,?)').run(1,remoteOp,saleId,remoteActor,JSON.stringify(event));
  assert.deepEqual((await readLocalSaleCashLedger(tx,identity,[sale],'2026-11-09')).refunds,[]);
  assert.equal((await readLocalSaleCashLedger(tx,identity,[sale],'2026-11-08')).initialPayments[0].paid,50000);
  db.prepare('UPDATE credit_local_sale_reconcile_prototype SET event=?').run('{}');await assert.rejects(readLocalSaleCashLedger(tx,identity,[sale],'2026-11-08'),/Historique distant incohérent/);
  db.prepare('DELETE FROM credit_local_sale_reconcile_prototype').run();db.prepare('UPDATE sale_revisions SET refund=1').run();await assert.rejects(readLocalSaleCashLedger(tx,identity,[sale],'2026-11-09'),/incohérent/);
  db.prepare('DELETE FROM sale_revisions').run();await assert.rejects(readLocalSaleCashLedger(tx,identity,[sale],'2026-11-08'),/incomplet/);
 }finally{db.close();}
});

test('vente d’un autre téléphone : sortie de caisse distincte, sans vendre deux fois',()=>{
 const clientId=randomUUID(),invoiceId=randomUUID(),remote={operationId:randomUUID(),invoiceId,clientId,clientName:'<Client>',recordedAt:'2026-11-08T09:00:00.000Z',refund:2400};
 const report={day:'2026-11-08',commercial:'Test',rows:[],receipts:[],credits:[],remoteSaleRefunds:[remote],initialSalePayments:[],saleRefunds:[]};
 const model=describeCreditJournalPrototype(report);assert.equal(model.remoteSaleRefundTotal,2400);assert.equal(model.totals.collectedGross,0);assert.equal(model.totals.collectedAfterLocalRefunds,-2400);
 assert.match(journalCsv(report),/REMBOURSEMENTS SUR VENTES D’AUTRES APPAREILS/);assert.match(journalCsv(report),/2,400/);assert.match(journalHtml(report),/&lt;Client&gt;/);
 assert.throws(()=>journalCsv({...report,remoteSaleRefunds:[remote,remote]}),/invalide/);
 assert.throws(()=>journalCsv({...report,remoteSaleRefunds:[{...remote,recordedAt:'2026-11-09T09:00:00.000Z'}]}),/invalide/);
 assert.throws(()=>journalCsv({...report,credits:undefined}),/Avoirs locaux indisponibles/);
});
