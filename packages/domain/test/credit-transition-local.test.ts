import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson} from '@sls/domain';
import {assertTransitionLocalHistory} from '../../../apps/mobile/credit-transition-local.js';

test('transition avoir : chaque opération locale doit avoir une preuve serveur correspondante',async()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
  CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
  CREATE TABLE tour_pre_invoices(id TEXT PRIMARY KEY,client_id TEXT,payload TEXT);
  CREATE TABLE journal_sync_state(invoice_id TEXT PRIMARY KEY,version INTEGER,payload TEXT);`);
  const tx={getAllAsync:async<T>(sql:string,...params:(string|number|null)[])=>db.prepare(sql).all(...params) as T[]};
  const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');
  const client=randomUUID(),saleId=randomUUID(),paymentId=randomUUID(),journalId=randomUUID();
  const sale={clientId:client,syncSaleId:saleId,syncVersion:1,total:1000,paid:100,name:'original'};
  const payment={clientId:client,syncOperationId:paymentId,amount:100};
  const journal={version:1,invoice:{id:journalId,clientId:client,amount:200},receipts:[]};
  db.prepare('INSERT INTO sales VALUES(1,?,?)').run(client,JSON.stringify(sale));
  db.prepare('INSERT INTO settlements VALUES(1,?,?)').run(client,JSON.stringify(payment));
  db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?)').run(journalId,client,JSON.stringify(journal.invoice));
  db.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(journalId,1,JSON.stringify(journal));
  const ref:any={saleStates:[{saleId,clientId:client,version:1,total:'1000',paid:'100',creditNote:null}],eligibleSaleProofs:[{saleId,version:1,hash:await digest(canonicalJson(sale))}],settlementStates:[{operationId:paymentId,clientId:client}],journalStates:[{id:journalId,clientId:client,creditNote:null}],journalProofs:[{id:journalId,version:1,hash:await digest(canonicalJson(journal))}]};
  await assertTransitionLocalHistory(tx,ref,digest);
  await assert.rejects(assertTransitionLocalHistory(tx,{...ref,saleStates:[]},digest),/Vente locale/);
  db.prepare('UPDATE sales SET payload=?').run(JSON.stringify({...sale,name:'modifié'}));
  await assert.rejects(assertTransitionLocalHistory(tx,ref,digest),/Vente locale/);
  db.prepare('UPDATE sales SET payload=?').run(JSON.stringify(sale));
  await assert.rejects(assertTransitionLocalHistory(tx,{...ref,settlementStates:[]},digest),/Règlement local/);
  db.prepare('UPDATE journal_sync_state SET payload=?').run(JSON.stringify({...journal,receipts:[{id:randomUUID()}]}));
  await assert.rejects(assertTransitionLocalHistory(tx,ref,digest),/Préétablie locale/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sales').get()?.n,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM settlements').get()?.n,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM tour_pre_invoices').get()?.n,1);
 }finally{db.close();}
});
