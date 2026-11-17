import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {dayInvoiceServerSchema,storeDayInvoicePayment} from '../src/day-invoice-store.js';
import {readServerDayInvoiceSource} from '../src/day-invoice-source.js';
import {readDayInvoiceReference} from '../src/day-invoice-reference.js';
import {storeJournalSnapshot} from '../src/journal-store.js';
import {storeIdentifiedSale,storeIdentifiedSettlement} from '../src/identified-operations.js';
import {setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {changeTourClosure} from '../src/tour-closure-store.js';
import type {DayInvoicePayment} from '../../../packages/domain/src/day-invoice.js';
import {readIdentifiedJournalDay} from '../src/identified-journal-day.js';
import {readServerDayInvoiceCash} from '../src/day-invoice-cash.js';
import {compareDayInvoiceCash} from '../../../packages/domain/src/day-invoice-cash.js';

test('PostgreSQL isolé : écriture atomique, conflit, reprise et clôture des règlements du jour',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');
 const schema='sls_day_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined,created=false;
 try {
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});
  await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);
  const clientId=randomUUID(),commercialId=randomUUID(),invoiceId=randomUUID(),saleId=randomUUID();
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[clientId,'Client fictif',0]);
  await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);
  await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif suffisamment long pour les tests';
  await setCommercialCredentials(pool,'admin',commercialId,{login:'day.test',password:'mot de passe fictif'});
  const login=await loginCommercial(pool,secret,{login:'day.test',password:'mot de passe fictif'});assert.ok(login);
  const session={secret,token:login.token},day='2026-01-01';
  const make=(amount:number):DayInvoicePayment=>({operationId:randomUUID(),clientId,day,recordedAt:'2026-01-01T12:00:00.000Z',amount,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]});
  const at='2026-01-01T09:00:00.000Z';
  const invoice={id:invoiceId,journalDate:day,clientId,clientName:'Client fictif',sector:'',amount:600000,createdAt:at};
  await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',{...session,enforceMode:true});
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:210084,discount:0,vat:1900}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},{...session,enforceMode:true});
  const source=readServerDayInvoiceSource;
  const first=make(200000);
  const same=await Promise.all([storeDayInvoicePayment(pool,first,session,source),storeDayInvoicePayment(pool,first,session,source)]);assert.deepEqual(same.sort(),['duplicate','received']);
  await assert.rejects(storeDayInvoicePayment(pool,{...first,amount:210000},session,source),/déjà utilisé/);
  const second={...make(100000),preInvoice:{...first.preInvoice!,declare:false}};
  assert.equal(await storeDayInvoicePayment(pool,second,session,source),'received');
  const reference=await readDayInvoiceReference(pool);assert.equal(reference.version,6);assert.equal(reference.clients.find(c=>c.id===clientId)?.serverBalance,'550000');
  assert.equal(reference.dayPayments.length,2);assert.equal(reference.journalStates.find(j=>j.id===invoiceId)?.declaredByDayPayment,true);
  const report=await readIdentifiedJournalDay(pool,commercialId,day,true);
  assert.equal(report.totalBilled,850000);assert.equal(report.journalCollected,300000);assert.equal(report.totalCollected,300000);
  assert.equal(report.rows[0].dayInvoicePaid,300000);assert.equal(report.rows[0].declared,true);
  const db=await pool.connect();try {const cash=await readServerDayInvoiceCash(db,commercialId,day);assert.equal(cash.length,2);assert.equal(compareDayInvoiceCash([first,second],cash,day).matches,true);}finally{db.release();}

  const stale=make(1000);await assert.rejects(storeDayInvoicePayment(pool,stale,session,source),/actualisation/);
  // Deux commerciaux : une nouvelle vente pour le même client/jour ne peut
  // pas se glisser entre lecture des sources et validation du paiement.
  const otherId=randomUUID();await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[otherId,'Autre commercial fictif']);
  await setCommercialCredentials(pool,'admin',otherId,{login:'day.other',password:'mot de passe fictif'});
  const other=await loginCommercial(pool,secret,{login:'day.other',password:'mot de passe fictif'});assert.ok(other);
  // Encaissement par un autre commercial après minuit en Tunisie : ni la
  // facture ni le premier encaissement ne changent de propriétaire.
  const later={...make(50000),recordedAt:'2026-01-01T23:30:00.000Z',preInvoice:{...first.preInvoice!,declare:false}};
  assert.equal(await storeDayInvoicePayment(pool,later,{secret,token:other.token},source),'received');
  const otherReport=await readIdentifiedJournalDay(pool,otherId,'2026-01-02',true);
  assert.equal(otherReport.totalBilled,0);assert.equal(otherReport.journalCollected,50000);assert.equal(otherReport.rows[0].dayInvoicePaid,50000);
  assert.equal((await readIdentifiedJournalDay(pool,commercialId,day,true)).journalCollected,300000);
  // Une première déclaration saisie le lendemain par B doit aussi rendre la
  // préétablie visible comme traitée dans le journal original de A.
  const c3=randomUUID(),i3=randomUUID(),s3=randomUUID();
  await pool!.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[c3,'Troisième client fictif']);
  await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice:{...invoice,id:i3,clientId:c3,clientName:'Troisième client fictif'},receipts:[]},'identified',{...session,enforceMode:true});
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId:s3,version:1,recordedAt:at,sale:{...sale,clientId:c3,clientName:'Troisième client fictif',syncSaleId:s3},refund:0},{...session,enforceMode:true});
  const declaration={...later,operationId:randomUUID(),clientId:c3,preInvoice:{id:i3,version:1,total:600000,declare:true},sales:[{id:s3,version:1}]};
  assert.equal(await storeDayInvoicePayment(pool,declaration,{secret,token:other.token},source),'received');
  const originalReport=await readIdentifiedJournalDay(pool,commercialId,day,true);
  assert.equal(originalReport.rows.find(r=>r.clientId===c3)?.declared,true);
  assert.equal(originalReport.rows.find(r=>r.clientId===c3)?.dayInvoicePaid,0);
  assert.equal(originalReport.journalCollected,300000);

  const otherDb=await pool.connect();try{const cash=await readServerDayInvoiceCash(otherDb,otherId,'2026-01-02');assert.equal(compareDayInvoiceCash([later,declaration],cash,'2026-01-02').matches,true);}finally{otherDb.release();}

  let signal!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{signal=r;}),barrier=new Promise<void>(r=>{release=r;});
  const third={...make(1000),preInvoice:{...first.preInvoice!,declare:false}};
  const paying=storeDayInvoicePayment(pool,third,session,async(db,event)=>{const result=await source(db,event);signal();await barrier;return result;});
  await entered;
  const newSaleId=randomUUID(),newSale={...sale,syncSaleId:newSaleId};
  const selling=storeIdentifiedSale(pool,{operationId:randomUUID(),saleId:newSaleId,version:1,recordedAt:at,sale:newSale,refund:0},{secret,token:other.token,enforceMode:true}).then(value=>({value,error:null}),error=>({value:null,error}));
  try {const early=await Promise.race([selling.then(()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),150))]);assert.equal(early,false);} finally {release();}
  assert.equal(await paying,'received');assert.match(String((await selling).error),/Règlement unifié déjà enregistré/);
  const settlementId=randomUUID(),settlement={operationId:settlementId,settlement:{syncOperationId:settlementId,createdAt:at,clientId,clientName:'Client fictif',amount:1000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}};
  await assert.rejects(storeIdentifiedSettlement(pool,settlement,{...session,enforceMode:true}),/Règlement unifié déjà enregistré/);
  const receipt={id:randomUUID(),preInvoiceId:invoiceId,clientId,journalDate:day,createdAt:at,prePaid:1000,oldDebtPaid:0,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:0};
  await assert.rejects(storeJournalSnapshot(pool,{operationId:randomUUID(),version:2,invoice,receipts:[receipt]},'identified',{...session,enforceMode:true}),/Règlement unifié déjà enregistré/);
  const reused={...settlement,operationId:first.operationId,settlement:{...settlement.settlement,syncOperationId:first.operationId}};
  await assert.rejects(storeIdentifiedSettlement(pool,reused,{...session,enforceMode:true}),/Identifiant déjà utilisé/);
  // Client encore sans paiement : la concurrence contre un règlement global
  // d'un autre commercial, même sur une autre date, doit être sérialisée par le verrou client global.
  const c2=randomUUID(),i2=randomUUID(),s2=randomUUID();
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[c2,'Second client fictif']);
  const invoice2={...invoice,id:i2,clientId:c2};
  await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice:invoice2,receipts:[]},'identified',{...session,enforceMode:true});
  const sale2={...sale,syncSaleId:s2,clientId:c2};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId:s2,version:1,recordedAt:at,sale:sale2,refund:0},{...session,enforceMode:true});
  const event2={...make(200000),operationId:randomUUID(),clientId:c2,preInvoice:{id:i2,version:1,total:600000,declare:true},sales:[{id:s2,version:1}]};
  let entered2!:()=>void,release2!:()=>void;const started2=new Promise<void>(r=>{entered2=r;}),barrier2=new Promise<void>(r=>{release2=r;});
  const pay2=storeDayInvoicePayment(pool,event2,session,async(db,event)=>{const result=await source(db,event);entered2();await barrier2;return result;});
  await started2;
  const settlement2Id=randomUUID(),settlement2={operationId:settlement2Id,settlement:{...settlement.settlement,syncOperationId:settlement2Id,clientId:c2,createdAt:'2026-01-02T09:00:00.000Z'}};
  const concurrent=storeIdentifiedSettlement(pool,settlement2,{secret,token:other.token,enforceMode:true}).then(value=>({value,error:null}),error=>({value:null,error}));
  try {assert.equal(await Promise.race([concurrent.then(()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),150))]),false);} finally {release2();}
  assert.equal(await pay2,'received');assert.match(String((await concurrent).error),/Règlement unifié déjà enregistré/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_settlements WHERE operation_id=$1',[settlement2Id])).rows[0].n,0);
  // Le protocole v6 peut créer de nouvelles sources après un paiement sans
  // autoriser l'ancien client à ignorer le solde ; une révision v6 doit respecter les paiements.
  const c4=randomUUID(),s4=randomUUID();await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[c4,'Quatrième client']);
  const sale4={...sale,clientId:c4,clientName:'Quatrième client',syncSaleId:s4};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId:s4,version:1,recordedAt:at,sale:sale4,refund:0},{...session,enforceMode:true});
  const p4={...make(100000),operationId:randomUUID(),clientId:c4,recordedAt:'2026-01-01T09:30:00.000Z',preInvoice:null,sales:[{id:s4,version:1}]};
  assert.equal(await storeDayInvoicePayment(pool,p4,session,source),'received');
  const s5=randomUUID(),sale5={...sale4,syncSaleId:s5,createdAt:'2026-01-01T09:45:00.000Z'};
  const newEvent={operationId:randomUUID(),saleId:s5,version:1,recordedAt:sale5.createdAt,sale:sale5,refund:0};
  await assert.rejects(storeIdentifiedSale(pool,newEvent,{...session,enforceMode:true}),/Règlement unifié/);
  assert.equal(await storeIdentifiedSale(pool,newEvent,{...session,enforceMode:true,dayInvoiceAware:true}),'received');
  assert.equal(await storeIdentifiedSale(pool,newEvent,{...session,enforceMode:true}),'duplicate');
  const edited={operationId:randomUUID(),saleId:s4,version:2,recordedAt:'2026-01-01T10:00:00.000Z',sale:{...sale4,syncVersion:2},refund:0};
  assert.equal(await storeIdentifiedSale(pool,edited,{...session,enforceMode:true,dayInvoiceAware:true}),'received');
  await assert.rejects(storeDayInvoicePayment(pool,{...p4,operationId:randomUUID()},session,source),/Ventes modifiées/);
  const nextInvoice={...invoice,id:randomUUID(),clientId:c4,clientName:'Quatrième client',journalDate:day,createdAt:'2026-01-01T10:01:00.000Z'};
  const journalEvent={operationId:randomUUID(),version:1,invoice:nextInvoice,receipts:[]};
  await assert.rejects(storeJournalSnapshot(pool,journalEvent,'identified',{...session,enforceMode:true}),/Règlement unifié/);
  assert.equal(await storeJournalSnapshot(pool,journalEvent,'identified',{...session,enforceMode:true,dayInvoiceAware:true}),'received');
  const ref4=await readDayInvoiceReference(pool);assert.equal(ref4.clients.find(c=>c.id===c4)?.serverBalance,'400000');
  const {validateDayInvoiceReference}=await import('../../mobile/day-invoice-reference.js');
  const {buildMergedDayInvoiceView}=await import('../../mobile/day-invoice-merged-view.js');
  const merged4=buildMergedDayInvoiceView(validateDayInvoiceReference(ref4),{clientId:c4,day,preInvoice:null,sales:[],receiptProof:[],oldDebtPaid:0,dayPayments:[]},[]);
  assert.equal(merged4.total,1100000);assert.equal(merged4.paid,100000);assert.equal(merged4.remaining,1000000);assert.equal(merged4.declared,false);
  const pay4={...p4,operationId:randomUUID(),recordedAt:'2026-01-01T10:02:00.000Z',amount:100000,preInvoice:{id:nextInvoice.id,version:1,total:600000,declare:true},sales:[{id:s4,version:2},{id:s5,version:1}].sort((a,b)=>a.id.localeCompare(b.id))};
  assert.equal(await storeDayInvoicePayment(pool,pay4,session,source),'received');assert.equal((await readDayInvoiceReference(pool)).clients.find(c=>c.id===c4)?.serverBalance,'900000');

  const actor={id:commercialId,role:'commercial' as const};await assert.rejects(changeTourClosure(pool,commercialId,day,'close',actor,0),/absents du calcul de clôture/);
  assert.equal(await storeDayInvoicePayment(pool,first,session,source),'duplicate');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_day_invoice_payments')).rows[0].n,8);
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
