import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readLocalSaleRefundsForJournal} from '../../../apps/mobile/credit-sale-refund-journal-prototype.js';
import {describeCreditJournalPrototype} from '../../../apps/mobile/credit-note-journal-view-model-prototype.js';
import {journalCsv,journalHtml} from '../../../apps/mobile/journal-export.js';
import type {SavedSale} from '../../../apps/mobile/storage.js';

test('journal mobile v5 : remboursement local, dates tunisiennes, exports et garde des deux jours',async()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE sale_revisions(id INTEGER PRIMARY KEY,sale_id INTEGER,created_at TEXT,previous_payload TEXT,new_payload TEXT,refund INTEGER); CREATE TABLE credit_local_sale_reconcile_prototype(revision_id INTEGER);');
  const clientId=randomUUID(),saleId=randomUUID(),sale:SavedSale={id:1,createdAt:'2026-11-07T23:30:00.000Z',clientId,clientName:'<Client>',syncSaleId:saleId,syncVersion:2,lines:[],total:11900,paid:11900,remaining:0,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  const prev={...sale,syncVersion:1,total:119000,paid:50000,remaining:69000};
  const add=(id:number,at:string,refund=38100)=>db.prepare('INSERT INTO sale_revisions VALUES(?,?,?,?,?,?)').run(id,1,at,JSON.stringify(prev),JSON.stringify(sale),refund);
  const tx={getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>db.prepare(sql).all(...args) as T[]};
  add(1,'2026-11-08T09:00:00.000Z');const same=await readLocalSaleRefundsForJournal(tx,[sale],'2026-11-08');assert.equal(same.length,1);assert.equal(same[0].refund,38100);
  const report={day:'2026-11-08',commercial:'Test',rows:[{clientId,clientName:'<Client>',sector:'',preInvoice:null,sales:[sale],total:11900}],receipts:[],credits:[],saleRefunds:same};
  const csv=journalCsv(report),html=journalHtml(report);assert.match(csv,/38,100/);assert.match(csv,/11,900/);assert.match(csv,/ne pas les déduire à nouveau/);assert.match(html,/&lt;Client&gt;/);assert.match(html,/38,100/);
  const model=describeCreditJournalPrototype(report);assert.equal(model.saleRefundTotal,38100);assert.equal(model.totals.collectedGross,11900);assert.equal(model.totals.collectedAfterLocalRefunds,11900);
  assert.throws(()=>journalCsv({...report,saleRefunds:[same[0],same[0]]}),/invalide/);
  db.prepare('UPDATE sale_revisions SET created_at=? WHERE id=1').run('2026-11-08T23:30:00.000Z');
  await assert.rejects(readLocalSaleRefundsForJournal(tx,[sale],'2026-11-08'),/autre journée/);
  await assert.rejects(readLocalSaleRefundsForJournal(tx,[sale],'2026-11-09'),/autre journée/);
  assert.deepEqual(await readLocalSaleRefundsForJournal(tx,[sale],'2026-11-10'),[]);
  db.prepare('UPDATE sale_revisions SET created_at=? WHERE id=1').run('2026-11-08T09:00:00.000Z');db.prepare('INSERT INTO credit_local_sale_reconcile_prototype VALUES(1)').run();
  await assert.rejects(readLocalSaleRefundsForJournal(tx,[sale],'2026-11-08'),/enregistré ailleurs/);
  db.prepare('DELETE FROM credit_local_sale_reconcile_prototype').run();db.prepare('UPDATE sale_revisions SET refund=1 WHERE id=1').run();
  await assert.rejects(readLocalSaleRefundsForJournal(tx,[sale],'2026-11-08'),/incohérent/);
 }finally{db.close();}
});

test('vente d’un autre téléphone : sortie de caisse distincte, sans vendre deux fois',()=>{
 const clientId=randomUUID(),invoiceId=randomUUID(),remote={operationId:randomUUID(),invoiceId,clientId,clientName:'<Client>',recordedAt:'2026-11-08T09:00:00.000Z',refund:2400};
 const report={day:'2026-11-08',commercial:'Test',rows:[],receipts:[],credits:[],remoteSaleRefunds:[remote]};
 const model=describeCreditJournalPrototype(report);assert.equal(model.remoteSaleRefundTotal,2400);assert.equal(model.totals.collectedGross,0);assert.equal(model.totals.collectedAfterLocalRefunds,-2400);
 assert.match(journalCsv(report),/REMBOURSEMENTS SUR VENTES D’AUTRES APPAREILS/);assert.match(journalCsv(report),/2,400/);assert.match(journalHtml(report),/&lt;Client&gt;/);
 assert.throws(()=>journalCsv({...report,remoteSaleRefunds:[remote,remote]}),/invalide/);
 assert.throws(()=>journalCsv({...report,remoteSaleRefunds:[{...remote,recordedAt:'2026-11-09T09:00:00.000Z'}]}),/invalide/);
 assert.throws(()=>journalCsv({...report,credits:undefined}),/Avoirs locaux indisponibles/);
});
