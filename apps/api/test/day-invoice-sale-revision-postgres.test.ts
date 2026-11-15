/** Révision v6 expérimentale : la transaction ne peut pas masquer un trop-perçu. */
import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';import pg from 'pg';
import express from 'express';import {createServer,type Server} from 'node:http';
import {identifiedCommercialRoutes} from '../src/identified-tour-routes.js';
import {schemaSql} from '../src/schema.js';import {dayInvoiceServerSchema,storeDayInvoicePayment} from '../src/day-invoice-store.js';
import {setCommercialCredentials} from '../src/commercials.js';import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale} from '../src/identified-operations.js';import {storeJournalSnapshot} from '../src/journal-store.js';
import {readIdentifiedJournalDay} from '../src/identified-journal-day.js';
import {storeDayInvoiceOldDebt} from '../src/day-invoice-old-debt.js';
import {readServerDayInvoiceSource} from '../src/day-invoice-source.js';import {readDayInvoiceReference} from '../src/day-invoice-reference.js';
import {requestTourTransition} from '../src/tour-closure-store.js';
import {readSaleCashPreview} from '../src/sale-cash-preview-prototype.js';
import {readJournalCashReconciliation} from '../src/journal-cash-reconciliation-prototype.js';
import {readServerDayInvoiceCash} from '../src/day-invoice-cash.js';
import {readDayInvoiceOwnerDeclarations} from '../src/day-invoice-journal.js';
import {dayInvoiceCashClosureCanonical} from '../../../packages/domain/src/day-invoice-cash.js';
import {validateDayInvoiceReference} from '../../mobile/day-invoice-reference.js';import {buildMergedDayInvoiceView} from '../../mobile/day-invoice-merged-view.js';

test('révision d’une vente v6 : montant combiné, paiements conservés et concurrence',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');const schema='sls_rev_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined,server:Server|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);
  const clientId=randomUUID(),commercialId=randomUUID(),saleId=randomUUID(),invoiceId=randomUUID(),day='2026-01-01',at='2026-01-01T09:00:00.000Z';
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[clientId,'Client fictif']);await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif suffisamment long pour les tests';await setCommercialCredentials(pool,'admin',commercialId,{login:'revision.day',password:'mot de passe fictif'});const login=await loginCommercial(pool,secret,{login:'revision.day',password:'mot de passe fictif'});assert.ok(login);const session={secret,token:login.token,enforceMode:true};
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:250000,discount:0,vat:0}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},session);
  const invoice={id:invoiceId,journalDate:day,clientId,clientName:'Client fictif',sector:'',amount:600000,createdAt:at};await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',session);
  const payment={operationId:randomUUID(),clientId,day,recordedAt:at,amount:800000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]};
  assert.equal(await storeDayInvoicePayment(pool,payment,session,readServerDayInvoiceSource),'received');
  const edit=(version:number,amount:number)=>({operationId:randomUUID(),saleId,version,recordedAt:`2026-01-01T${String(9+version).padStart(2,'0')}:00:00.000Z`,sale:{...sale,syncVersion:version,lines:[{...sale.lines[0],unitPrice:amount}],total:amount,remaining:amount},refund:0});
  const increase=edit(2,300000);await assert.rejects(storeIdentifiedSale(pool,increase,session),/Règlement unifié/);
  const app=express();app.use(express.json());app.use('/normal',identifiedCommercialRoutes(pool,secret));app.use('/test',identifiedCommercialRoutes(pool,secret,{dayInvoiceTestOnly:true}));server=createServer(app);
  await new Promise<void>((resolve,reject)=>server!.listen(0,'127.0.0.1',()=>resolve()).once('error',reject));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const post=(path:string,data:unknown,auth=true)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${login.token}`}:{})},body:JSON.stringify(data)});
  assert.equal((await post('/normal/day-invoice-sources/sales',increase)).status,404);assert.equal((await post('/test/day-invoice-sources/sales',increase,false)).status,401);
  assert.equal((await post('/test/day-invoice-sources/sales',increase)).status,201);const repeat=await post('/test/day-invoice-sources/sales',increase);assert.equal(repeat.status,200);assert.deepEqual(await repeat.json(),{status:'duplicate',operationId:increase.operationId});
  const state=validateDayInvoiceReference(await readDayInvoiceReference(pool));assert.equal(state.clients.find(c=>c.id===clientId)?.serverBalance,'100000');
  const projection=buildMergedDayInvoiceView(state,{clientId,day,preInvoice:null,sales:[],receiptProof:[],oldDebtPaid:0,dayPayments:[]},[]);assert.equal(projection.total,900000);assert.equal(projection.paid,800000);assert.equal(projection.remaining,100000);
  const journal=await readIdentifiedJournalDay(pool,commercialId,day,true),row=journal.rows.find(r=>r.clientId===clientId);assert.ok(row);assert.equal(row.preInvoiceTotal,600000);assert.equal(row.tourTotal,300000);assert.equal(row.totalClient,900000);assert.equal(row.dayInvoicePaid,800000);assert.equal(journal.totalCollected,800000);
  const below=edit(3,150000);const rejected=await post('/test/day-invoice-sources/sales',below);assert.equal(rejected.status,409);assert.match((await rejected.json() as {error:string}).error,/remboursement ou crédit/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_sale_events WHERE sale_id=$1',[saleId])).rows[0].n,2);
  const equal=edit(3,200000);assert.equal(await storeIdentifiedSale(pool,equal,{...session,dayInvoiceAware:true}),'received');
  const ref=validateDayInvoiceReference(await readDayInvoiceReference(pool));const final=buildMergedDayInvoiceView(ref,{clientId,day,preInvoice:null,sales:[],receiptProof:[],oldDebtPaid:0,dayPayments:[]},[]);assert.equal(final.total,800000);assert.equal(final.paid,800000);assert.equal(final.remaining,0);assert.equal(ref.clients.find(c=>c.id===clientId)?.serverBalance,'0');
  // Deux téléphones : la révision et un paiement avec une ancienne version ne
  // peuvent pas être acceptés ensemble, quel que soit l'ordre des verrous.
  const c2=randomUUID(),s2=randomUUID();await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[c2,'Autre client']);
  const second={...sale,clientId:c2,clientName:'Autre client',syncSaleId:s2};await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId:s2,version:1,recordedAt:at,sale:second,refund:0},session);
  const revised={operationId:randomUUID(),saleId:s2,version:2,recordedAt:'2026-01-01T12:00:00.000Z',sale:{...second,syncVersion:2,lines:[{...second.lines[0],unitPrice:100000}],total:100000,remaining:100000},refund:0};
  const concurrentPayment={...payment,operationId:randomUUID(),clientId:c2,amount:200000,preInvoice:null,sales:[{id:s2,version:1}]};
  const outcomes=await Promise.allSettled([storeIdentifiedSale(pool,revised,{...session,dayInvoiceAware:true}),storeDayInvoicePayment(pool,concurrentPayment,session,readServerDayInvoiceSource)]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.equal(outcomes.filter(o=>o.status==='rejected').length,1);
  // Une dette réglée peut dépendre d'une facture antérieure : tant que son
  // recalcul historique n'est pas disponible, toute révision reste bloquée.
  const c3=randomUUID(),s3=randomUUID(),debtId=randomUUID();await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,100000)',[c3,'Client dette']);
  const third={...sale,clientId:c3,clientName:'Client dette',syncSaleId:s3};await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId:s3,version:1,recordedAt:at,sale:third,refund:0},session);
  await storeDayInvoiceOldDebt(pool,{invoiceDay:day,event:{operationId:debtId,settlement:{syncOperationId:debtId,createdAt:at,clientId:c3,clientName:'Client dette',amount:50000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}}},session);
  await assert.rejects(storeIdentifiedSale(pool,{operationId:randomUUID(),saleId:s3,version:2,recordedAt:'2026-01-01T12:00:00.000Z',sale:{...third,syncVersion:2},refund:0},{...session,dayInvoiceAware:true}),/règlement de dette/);
  const proof=async()=>{const db=await pool!.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const saleCash=await readSaleCashPreview(db,commercialId,day);assert.ok(saleCash.available);
   const sales={version:5,commercialId,day,initialEvents:saleCash.initialEvents,refundEvents:saleCash.refundEvents.map(({operationId,saleId,clientId,recordedAt,refund})=>({operationId,saleId,clientId,recordedAt,refund})),saleStates:saleCash.entries.filter(e=>saleCash.initialEvents.some(p=>p.saleId===e.saleId)).map(({saleId,clientId,version,total,paid})=>({saleId,clientId,version,total,paid}))};
   const canonical=dayInvoiceCashClosureCanonical(sales,await readJournalCashReconciliation(db,commercialId,day),await readServerDayInvoiceCash(db,commercialId,day),commercialId,day,await readDayInvoiceOwnerDeclarations(db,commercialId,day));await db.query('COMMIT');return createHash('sha256').update(canonical).digest('hex');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}};
  const stale=await proof(),lastEdit=edit(4,210000);assert.equal(await storeIdentifiedSale(pool,lastEdit,{...session,dayInvoiceAware:true}),'received');
  const requestId=randomUUID(),principal={kind:'commercial' as const,secret,token:login.token};
  await assert.rejects(requestTourTransition(pool,{requestId,day,expectedVersion:0,cashProof:stale},principal,true,true,true,true),/Caisse différente/);
  const verified=await proof();assert.notEqual(verified,stale);const close={requestId,day,expectedVersion:0,cashProof:verified};
  assert.equal((await requestTourTransition(pool,close,principal,true,true,true,true)).status,'received');
  assert.equal((await requestTourTransition(pool,close,principal,true,true,true,true)).status,'duplicate');
  await assert.rejects(storeIdentifiedSale(pool,edit(5,220000),{...session,dayInvoiceAware:true}),/clôtur/i);

 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await pool?.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
