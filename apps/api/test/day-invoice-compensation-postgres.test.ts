/** Test isolé : aucune route publique ne permet d'enregistrer ces choix. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {dayInvoiceServerSchema,storeDayInvoicePayment} from '../src/day-invoice-store.js';
import {setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale,storeDayInvoiceCompensatedSale} from '../src/identified-operations.js';
import {storeJournalSnapshot} from '../src/journal-store.js';
import {readServerDayInvoiceSource} from '../src/day-invoice-source.js';
import {readDayInvoiceReference,readDayInvoiceCompensationProjection} from '../src/day-invoice-reference.js';
import {readIdentifiedJournalDay} from '../src/identified-journal-day.js';

for(const choice of ['refund','credit'] as const)test(`compensation ${choice} : révision atomique, concurrence et reprise`,async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');
 const schema='sls_comp_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined;
 try {
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);
  const clientId=randomUUID(),commercialId=randomUUID(),saleId=randomUUID(),invoiceId=randomUUID(),day='2026-01-01',at='2026-01-01T09:00:00.000Z';
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,100000)',[clientId,'Client fictif']);await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif suffisamment long pour les tests';await setCommercialCredentials(pool,'admin',commercialId,{login:'comp.test',password:'mot de passe fictif'});const login=await loginCommercial(pool,secret,{login:'comp.test',password:'mot de passe fictif'});assert.ok(login);const session={token:login.token,secret};
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Article',code:'X',quantity:1,unitPrice:250000,discount:0,vat:0}],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  const creationId=randomUUID();await storeIdentifiedSale(pool,{operationId:creationId,saleId,version:1,recordedAt:at,sale,refund:0},{...session,enforceMode:true});
  const invoice={id:invoiceId,journalDate:day,clientId,clientName:'Client fictif',sector:'',amount:600000,createdAt:at};await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',{...session,enforceMode:true});
  const payment={operationId:randomUUID(),clientId,day,recordedAt:'2026-01-01T09:30:00.000Z',amount:800000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]};await storeDayInvoicePayment(pool,payment,session,readServerDayInvoiceSource);
  const edit={operationId:randomUUID(),saleId,version:2,recordedAt:'2026-01-01T10:00:00.000Z',sale:{...sale,syncVersion:2,lines:[{...sale.lines[0],unitPrice:150000}],total:150000,remaining:150000},refund:0};
  const compensation={choice,amount:50000,previousTotal:850000,paid:800000};
  await assert.rejects(storeDayInvoiceCompensatedSale(pool,{...edit,operationId:randomUUID(),recordedAt:'2026-01-01T09:15:00.000Z'},compensation,session),/antérieure à un paiement/);
  for(const invalid of [{...compensation,amount:49999},{...compensation,previousTotal:849999},{...compensation,paid:799999}])await assert.rejects(storeDayInvoiceCompensatedSale(pool,edit,invalid,session),/compensation incohérente/);
  const nonExcess={...edit,operationId:randomUUID(),sale:{...edit.sale,lines:[{...sale.lines[0],unitPrice:300000}],total:300000,remaining:300000}};
  await assert.rejects(storeDayInvoiceCompensatedSale(pool,nonExcess,compensation,session),/compensation incohérente/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1',[saleId])).rows[0].n,1);
  // Une erreur d'insertion de compensation doit annuler la révision associée.
  await pool.query('ALTER TABLE identified_day_invoice_compensations ADD CONSTRAINT reject_test CHECK (false)');
  await assert.rejects(storeDayInvoiceCompensatedSale(pool,edit,compensation,session));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1',[saleId])).rows[0].n,1);
  await pool.query('ALTER TABLE identified_day_invoice_compensations DROP CONSTRAINT reject_test');
  const received=await Promise.all([storeDayInvoiceCompensatedSale(pool,edit,compensation,session),storeDayInvoiceCompensatedSale(pool,edit,compensation,session)]);
  assert.deepEqual(received.sort(),['duplicate','received']);
  const stored=await pool.query('SELECT payload,client_id,commercial_id FROM identified_day_invoice_compensations WHERE operation_id=$1',[edit.operationId]);assert.equal(stored.rows.length,1);assert.deepEqual(stored.rows[0].payload,compensation);assert.equal(stored.rows[0].client_id,clientId);assert.equal(stored.rows[0].commercial_id,commercialId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1',[saleId])).rows[0].n,2);
  const projection=await readDayInvoiceCompensationProjection(pool,edit.operationId);
  assert.deepEqual(projection,{operationId:edit.operationId,clientId,commercialId,invoiceDay:day,eventDay:day,recordedAt:edit.recordedAt,choice,compensation:50000,total:750000,paidBeforeCompensation:800000,applied:750000,remaining:0,balance:choice==='refund'?100000:50000,refund:choice==='refund'?50000:0,credit:choice==='credit'?50000:0});
  assert.equal((await pool.query("SELECT payload->'sale'->>'total' AS total FROM identified_sale_events WHERE operation_id=$1",[edit.operationId])).rows[0].total,'150000');
  // L'excédent peut compenser une dette ancienne ou créer un crédit net.
  await pool.query('UPDATE clients SET opening_balance=0 WHERE id=$1',[clientId]);
  assert.equal((await readDayInvoiceCompensationProjection(pool,edit.operationId)).balance,choice==='refund'?0:-50000);
  await pool.query('UPDATE clients SET opening_balance=100000 WHERE id=$1',[clientId]);
  const originalHash=(await pool.query('SELECT payload_hash FROM identified_sale_events WHERE operation_id=$1',[edit.operationId])).rows[0].payload_hash;
  await pool.query('UPDATE identified_sale_events SET payload_hash=$1 WHERE operation_id=$2',['0'.repeat(64),edit.operationId]);
  await assert.rejects(readDayInvoiceCompensationProjection(pool,edit.operationId),/Preuve de compensation incohérente/);
  await pool.query('UPDATE identified_sale_events SET payload_hash=$1 WHERE operation_id=$2',[originalHash,edit.operationId]);
  const previousHash=(await pool.query('SELECT payload_hash FROM identified_sale_events WHERE operation_id=$1',[creationId])).rows[0].payload_hash;
  await pool.query('UPDATE identified_sale_events SET payload_hash=$1 WHERE operation_id=$2',['0'.repeat(64),creationId]);
  await assert.rejects(readDayInvoiceCompensationProjection(pool,edit.operationId),/Version précédente incohérente/);
  await pool.query('UPDATE identified_sale_events SET payload_hash=$1 WHERE operation_id=$2',[previousHash,creationId]);
  await pool.query('INSERT INTO identified_day_invoice_compensations(operation_id,client_id,commercial_id,invoice_day,event_day,payload,payload_hash) VALUES($1,$2,$3,$4::date,$4::date,$5::jsonb,$6)',[creationId,clientId,commercialId,day,JSON.stringify(compensation),'0'.repeat(64)]);
  await assert.rejects(readDayInvoiceCompensationProjection(pool,edit.operationId),/ambiguë/);
  await pool.query('DELETE FROM identified_day_invoice_compensations WHERE operation_id=$1',[creationId]);



  await assert.rejects(storeDayInvoiceCompensatedSale(pool,edit,{...compensation,choice:choice==='refund'?'credit':'refund'},session),/Preuve de compensation incohérente/);
  await assert.rejects(storeIdentifiedSale(pool,edit,{...session,enforceMode:true,dayInvoiceAware:true}),/Reprise de compensation incohérente/);
  await pool.query("UPDATE identified_day_invoice_compensations SET payload=jsonb_set(payload,'{amount}','1'::jsonb) WHERE operation_id=$1",[edit.operationId]);
  await assert.rejects(storeDayInvoiceCompensatedSale(pool,edit,compensation,session),/Preuve de compensation incohérente/);
  await assert.rejects(readDayInvoiceCompensationProjection(pool,edit.operationId),/Preuve de compensation incohérente/);
  await pool.query('UPDATE identified_day_invoice_compensations SET payload=$1::jsonb WHERE operation_id=$2',[JSON.stringify(compensation),edit.operationId]);
  assert.equal(await storeDayInvoiceCompensatedSale(pool,edit,compensation,session),'duplicate');
  // Les écrans/projections non adaptés doivent refuser, pas afficher un faux solde.
  await assert.rejects(readDayInvoiceReference(pool,true),/non projetée/);
  await assert.rejects(readIdentifiedJournalDay(pool,commercialId,day,true),/non projetée/);
  const newPayment={...payment,operationId:randomUUID(),amount:1000,preInvoice:{...payment.preInvoice,declare:false},sales:[{id:saleId,version:2}]};
  await assert.rejects(storeDayInvoicePayment(pool,newPayment,session,readServerDayInvoiceSource),/non projetée/);
 }finally{await pool?.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
