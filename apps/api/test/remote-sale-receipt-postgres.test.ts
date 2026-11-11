/** Un reçu et sa référence doivent toujours venir du même instantané MVCC. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale} from '../src/identified-operations.js';
import {readLocalSaleHistoryPrototype} from '../src/local-sale-history-prototype.js';
import {readRemoteSaleReceiptPrototype} from '../src/remote-sale-receipt-prototype.js';
test('PostgreSQL : reçu et référence restent cohérents pendant une modification concurrente',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_receipt_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif assez long pour les tests',commercial=await saveCommercial(pool,'admin',{name:'Test',active:true});
  await setCommercialCredentials(pool,'admin',commercial.id,{login:'receipt.test',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'receipt.test',password:'mot de passe fictif'});assert.ok(session);const auth={secret,token:session.token,enforceMode:true,creditAware:true};
  const clientId=randomUUID(),saleId=randomUUID(),at='2026-11-07T09:00:00.000Z';await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[clientId,'Test']);
  const sale={createdAt:at,clientId,clientName:'Test',syncSaleId:saleId,syncVersion:1,lines:[{name:'Huile',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},auth);
  const event={operationId:randomUUID(),saleId,version:2,recordedAt:'2026-11-07T10:00:00.000Z',sale:{...sale,syncVersion:2},refund:0};
  await storeIdentifiedSale(pool,event,auth);
  let enter!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{enter=r;}),hold=new Promise<void>(r=>{release=r;});
  const pending=readRemoteSaleReceiptPrototype(pool,event.operationId,auth,async()=>{enter();await hold;});
  try{
   await started;
   await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:3,recordedAt:'2026-11-07T11:00:00.000Z',sale:{...sale,syncVersion:3},refund:0},auth);
  }finally{release();}
  const snapshot=await pending;assert.ok(snapshot);assert.equal(snapshot.event.version,2);assert.equal(snapshot.reference.saleStates.find(s=>s.saleId===saleId)?.version,2);
  const updated=await readRemoteSaleReceiptPrototype(pool,event.operationId,auth);assert.ok(updated);assert.equal(updated.event.version,2);assert.equal(updated.reference.saleStates.find(s=>s.saleId===saleId)?.version,3);
  let enterHistory!:()=>void,releaseHistory!:()=>void;const historyStarted=new Promise<void>(r=>{enterHistory=r;}),historyHold=new Promise<void>(r=>{releaseHistory=r;});
  const pendingHistory=readLocalSaleHistoryPrototype(pool,saleId,auth,async()=>{enterHistory();await historyHold;});
  try{
   await historyStarted;
   await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:4,recordedAt:'2026-11-07T12:00:00.000Z',sale:{...sale,syncVersion:4},refund:0},auth);
  }finally{releaseHistory();}
  const history=await pendingHistory;assert.ok(history);assert.equal(history.events.length,3);assert.equal(history.reference.saleStates.find(s=>s.saleId===saleId)?.version,3);
  const currentHistory=await readLocalSaleHistoryPrototype(pool,saleId,auth);assert.ok(currentHistory);assert.equal(currentHistory.events.length,4);assert.equal(currentHistory.reference.saleStates.find(s=>s.saleId===saleId)?.version,4);

 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
