/** Concurrence réelle sur deux clients et deux journées indépendants. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {dayInvoiceServerSchema,storeDayInvoicePayment} from '../src/day-invoice-store.js';
import {storeIdentifiedSale,storeDayInvoiceCompensatedSale} from '../src/identified-operations.js';
import {storeJournalSnapshot} from '../src/journal-store.js';
import {readServerDayInvoiceSource} from '../src/day-invoice-source.js';
import {readDayInvoiceCompensationProjection,readCompensatedDayInvoiceSnapshot,readDayInvoiceReference} from '../src/day-invoice-reference.js';
import {readCompensatedJournalDay,readIdentifiedJournalDay} from '../src/identified-journal-day.js';
import {readAdminCompensatedDay} from '../src/day-invoice-admin-summary.js';
import {validateCompensatedSummary} from '../../admin/src/day-invoice-compensated-summary.jsx';
import {readAuthenticatedCompensatedInvoice,readCompensationReceipt} from '../src/day-invoice-compensation-receipt.js';
import {setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';

test('deux compensations concurrentes sur des clients indépendants restent vérifiables',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');
 const schema='sls_comp_race_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});
  await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);
  const commercialId=randomUUID(),secret='secret fictif suffisamment long pour les tests';
  await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  await setCommercialCredentials(pool,'admin',commercialId,{login:'race.comp',password:'mot de passe fictif'});
  const login=await loginCommercial(pool,secret,{login:'race.comp',password:'mot de passe fictif'});assert.ok(login);
  const session={secret,token:login.token};
  const secondCommercial=randomUUID();await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[secondCommercial,'Second commercial fictif']);
  await setCommercialCredentials(pool,'admin',secondCommercial,{login:'race.comp.other',password:'mot de passe fictif'});
  const secondLogin=await loginCommercial(pool,secret,{login:'race.comp.other',password:'mot de passe fictif'});assert.ok(secondLogin);
  const secondSession={secret,token:secondLogin.token};
  const cases=[];
  for(const day of ['2026-01-01','2026-01-02','2026-01-04']){
   const clientId=randomUUID(),saleId=randomUUID(),invoiceId=randomUUID(),at=`${day}T09:00:00.000Z`;
   await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[clientId,'Client fictif']);
   const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:5,unitPrice:50000,discount:0,vat:0}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
   await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},{...session,enforceMode:true});
   const invoice={id:invoiceId,journalDate:day,clientId,clientName:'Client fictif',sector:'',amount:600000,createdAt:at};
   await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',{...session,enforceMode:true});
   await storeDayInvoicePayment(pool,{operationId:randomUUID(),clientId,day,recordedAt:`${day}T09:30:00.000Z`,amount:800000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]},session,readServerDayInvoiceSource);
   const event={operationId:randomUUID(),saleId,version:2,recordedAt:day==='2026-01-04'?'2026-01-05T10:00:00.000Z':'2026-01-03T10:00:00.000Z',sale:{...sale,syncVersion:2,lines:[{...sale.lines[0],quantity:3}],total:150000,remaining:150000},refund:0};
   const nextPayment={operationId:randomUUID(),clientId,day,recordedAt:`${day}T10:30:00.000Z`,amount:1000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:false},sales:[{id:saleId,version:1}]};
   cases.push({event,choice:{choice:day==='2026-01-01'?'refund':'credit',amount:50000,previousTotal:850000,paid:800000},nextPayment});
  }
  // Élargit la fenêtre entre contrôle et insertion : sans barrière globale,
  // les deux transactions peuvent chacune observer un registre vide.
  await pool.query(`CREATE FUNCTION delay_compensation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.8); RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER delay_compensation BEFORE INSERT ON identified_day_invoice_compensations FOR EACH ROW EXECUTE FUNCTION delay_compensation()');
  const first=storeDayInvoiceCompensatedSale(pool,cases[0].event,cases[0].choice,session);
  // Attendre que la première transaction soit bien dans le trigger avant de
  // lancer les autres appareils : un simple Promise.all serait non déterministe.
  let sleeping=false;
  for(let i=0;i<50&&!sleeping;i++){
   const result=await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event='PgSleep' AND query LIKE 'INSERT INTO identified_day_invoice_compensations%') AS waiting`);
   sleeping=result.rows[0].waiting;if(!sleeping)await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(sleeping,true,'première compensation non observée dans le trigger');
  const outcomesPromise=Promise.allSettled([first,storeDayInvoiceCompensatedSale(pool,cases[1].event,cases[1].choice,session)]);
  const conflictEvent={...cases[0].event,operationId:randomUUID()};
  const conflicting=storeDayInvoiceCompensatedSale(pool,conflictEvent,{...cases[0].choice,choice:'credit'},secondSession).then(value=>({value,error:null}),error=>({value:null,error}));
  const concurrentPayment=storeDayInvoicePayment(pool,cases[1].nextPayment,session,readServerDayInvoiceSource).then(value=>({value,error:null}),error=>({value:null,error}));
  const outcomes=await outcomesPromise,paymentResult=await concurrentPayment,conflictResult=await conflicting;
  assert.equal(conflictResult.value,null);assert.match(String(conflictResult.error),/Client déjà compensé|version/i);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_sale_events WHERE operation_id=$1',[conflictEvent.operationId])).rows[0].n,0);
  await assert.rejects(readCompensationReceipt(pool,cases[0].event.operationId,secondSession),/indisponible/);
  await assert.rejects(readAuthenticatedCompensatedInvoice(pool,cases[0].event.operationId,secondSession),/indisponible/);
  assert.equal(paymentResult.value,null);assert.match(String(paymentResult.error),/compensation|rapprochement/i);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_payments WHERE operation_id=$1',[cases[1].nextPayment.operationId])).rows[0].n,0);
  assert.deepEqual(outcomes.map(r=>r.status==='fulfilled'?r.value:String(r.reason)),['received','received']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_day_invoice_compensations')).rows[0].n,2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_sale_events WHERE version=2')).rows[0].n,2);
  for(const accepted of cases.slice(0,2)){assert.equal((await readDayInvoiceCompensationProjection(pool,accepted.event.operationId)).compensation,50000);
   assert.equal(await storeDayInvoiceCompensatedSale(pool,accepted.event,accepted.choice,session),'duplicate');}
  const snapshot=await readCompensatedDayInvoiceSnapshot(pool,cases[0].event.operationId);
  assert.equal(snapshot.reference.clients.find(c=>c.id===cases[0].event.sale.clientId)?.serverBalance,'0');
  assert.equal(snapshot.reference.clients.find(c=>c.id===cases[1].event.sale.clientId)?.serverBalance,'-50000');
  const journal=await readCompensatedJournalDay(pool,commercialId,'2026-01-03',cases[0].event.operationId);
  assert.equal(journal.compensationEvents.length,2);assert.equal(journal.compensationRefundTotal,50000);assert.equal(journal.compensationCreditTotal,50000);assert.equal(journal.collectedAfterCompensationRefund,-50000);
  const admin=validateCompensatedSummary(await readAdminCompensatedDay(pool,commercialId,'2026-01-03'),commercialId,'2026-01-03');
  assert.equal(admin.rows.length,2);assert.equal(admin.refund,50000);assert.equal(admin.credit,50000);assert.equal(admin.theoreticalNet,-50000);
  assert.equal(journal.rows.find(r=>r.clientId===cases[0].event.sale.clientId)?.compensationRefund,50000);
  assert.equal(journal.rows.find(r=>r.clientId===cases[1].event.sale.clientId)?.compensationCredit,50000);
  const clientView=await readAuthenticatedCompensatedInvoice(pool,cases[0].event.operationId,session);
  assert.equal(clientView.journal.refund,50000);assert.equal(clientView.journal.credit,50000);assert.equal(clientView.journal.ownRefund,50000);assert.equal(clientView.journal.ownCredit,0);
  const another=cases[0],third={...another.event,operationId:randomUUID(),version:3,recordedAt:'2026-01-03T11:00:00.000Z',sale:{...another.event.sale,syncVersion:3,lines:[{...another.event.sale.lines[0],quantity:2}],total:100000,remaining:100000}};
  await assert.rejects(storeDayInvoiceCompensatedSale(pool,third,{choice:'refund',amount:50000,previousTotal:750000,paid:750000},session),/Client déjà compensé/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_sale_events WHERE version=3')).rows[0].n,0);
  const original=(await pool.query('SELECT payload_hash FROM identified_day_invoice_compensations WHERE operation_id=$1',[cases[1].event.operationId])).rows[0].payload_hash;
  await pool.query('UPDATE identified_day_invoice_compensations SET payload_hash=$1 WHERE operation_id=$2',['0'.repeat(64),cases[1].event.operationId]);
  await assert.rejects(readCompensatedDayInvoiceSnapshot(pool,cases[0].event.operationId),/incohérente/);
  await assert.rejects(readCompensatedJournalDay(pool,commercialId,'2026-01-03',cases[0].event.operationId),/incohérente/);
  await assert.rejects(readAdminCompensatedDay(pool,commercialId,'2026-01-03'),/incohérente/);
  await assert.rejects(storeDayInvoiceCompensatedSale(pool,cases[2].event,cases[2].choice,session),/précédentes incohérentes/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_sale_events WHERE operation_id=$1',[cases[2].event.operationId])).rows[0].n,0);
  await pool.query('UPDATE identified_day_invoice_compensations SET payload_hash=$1 WHERE operation_id=$2',[original,cases[1].event.operationId]);
  assert.equal(await storeDayInvoiceCompensatedSale(pool,cases[2].event,cases[2].choice,session),'received');
  assert.equal((await readDayInvoiceCompensationProjection(pool,cases[2].event.operationId)).compensation,50000);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_day_invoice_compensations')).rows[0].n,3);
  await assert.rejects(readDayInvoiceReference(pool,true),/non projetée/);
  await assert.rejects(readIdentifiedJournalDay(pool,commercialId,'2026-01-03',true),/non projetée/);
 }finally{await pool?.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
