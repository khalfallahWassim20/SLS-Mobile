import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {dayInvoiceServerSchema} from '../src/day-invoice-schema.js';
import {assertLegacyClientDaySafe,assertLegacyDayInvoiceReferenceSafe} from '../src/day-invoice-legacy-guard.js';
import {readIdentifiedReference} from '../src/identified-reference.js';

/** Migration répétée exclusivement sur un schéma PostgreSQL fictif. */
test('migration préparatoire facture du jour : données conservées, relance et anciennes gardes',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');
 const schema='sls_day_migration_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  assert.ok(schemaSql.includes(dayInvoiceServerSchema));await pool.query(schemaSql.replace(dayInvoiceServerSchema,''));
  const clientId=randomUUID(),commercialId=randomUUID(),articleId=randomUUID();
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[clientId,'Client fictif',123456]);
  await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2)',[commercialId,'Commercial fictif']);
  await pool.query("INSERT INTO articles(id,code,name,purchase_ttc,sale_ttc,vat_rate) VALUES($1,'MIG','Article fictif',1000,1200,1900)",[articleId]);
  const saleId=randomUUID(),saleOperation=randomUUID(),invoiceId=randomUUID(),invoiceOperation=randomUUID(),at='2026-01-01T09:00:00.000Z';
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Article fictif',code:'MIG',quantity:1,unitPrice:1008,discount:0,vat:1900}],total:1200,paid:0,remaining:1200,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  const saleEvent={operationId:saleOperation,saleId,version:1,recordedAt:at,sale,refund:0},hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
  await pool.query("INSERT INTO identified_sale_events(operation_id,sale_id,version,client_id,commercial_id,journal_date,event_date,payload,payload_hash) VALUES($1,$2,1,$3,$4,'2026-01-01','2026-01-01',$5::jsonb,$6)",[saleOperation,saleId,clientId,commercialId,JSON.stringify(saleEvent),hash(saleEvent)]);
  const invoice={id:invoiceId,journalDate:'2026-01-01',clientId,clientName:'Client fictif',sector:'',amount:600000,createdAt:at},snapshot={operationId:invoiceOperation,version:1,invoice,receipts:[]};
  await pool.query("INSERT INTO identified_journal_invoices(id,client_id,journal_date,commercial_id) VALUES($1,$2,'2026-01-01',$3)",[invoiceId,clientId,commercialId]);
  await pool.query('INSERT INTO identified_journal_events(operation_id,invoice_id,commercial_id,version,payload,payload_hash) VALUES($1,$2,$3,1,$4::jsonb,$5)',[invoiceOperation,invoiceId,commercialId,JSON.stringify(snapshot),hash(snapshot)]);
  await pool.query("INSERT INTO tour_closures(commercial_id,journal_date,status,version,closed_at) VALUES($1,'2025-12-31','closed',1,'2025-12-31T18:00:00Z')",[commercialId]);
  const before=await readIdentifiedReference(pool);
  assert.equal((await pool.query("SELECT to_regclass('identified_day_invoice_payments') AS name")).rows[0].name,null);
  const lineage=(await pool.query('SELECT lineage_id FROM server_lineage_identity WHERE id=1')).rows[0].lineage_id;
  await pool.query(schemaSql);await pool.query(schemaSql);
  assert.equal((await pool.query('SELECT opening_balance::text AS balance FROM clients WHERE id=$1',[clientId])).rows[0].balance,'123456');
  assert.equal((await pool.query('SELECT name FROM commercials WHERE id=$1',[commercialId])).rows[0].name,'Commercial fictif');
  assert.equal((await pool.query('SELECT sale_ttc::text AS price FROM articles WHERE id=$1',[articleId])).rows[0].price,'1200');
  assert.equal((await pool.query('SELECT lineage_id FROM server_lineage_identity WHERE id=1')).rows[0].lineage_id,lineage);
  assert.deepEqual(await readIdentifiedReference(pool),before);
  assert.equal((await pool.query('SELECT payload_hash FROM identified_sale_events WHERE operation_id=$1',[saleOperation])).rows[0].payload_hash,hash(saleEvent));
  assert.equal((await pool.query('SELECT payload_hash FROM identified_journal_events WHERE operation_id=$1',[invoiceOperation])).rows[0].payload_hash,hash(snapshot));
  assert.equal((await pool.query("SELECT status FROM tour_closures WHERE commercial_id=$1 AND journal_date='2025-12-31'",[commercialId])).rows[0].status,'closed');
  const db=await pool.connect();try{
   await db.query('BEGIN');await assertLegacyClientDaySafe(db,clientId,'2026-01-01');await assertLegacyDayInvoiceReferenceSafe(db);await db.query('COMMIT');
  }finally{db.release();}
  const id=randomUUID();await pool.query("INSERT INTO identified_day_invoice_payments(operation_id,client_id,commercial_id,invoice_day,event_day,payload,payload_hash) VALUES($1,$2,$3,'2026-01-01','2026-01-01','{}','test')",[id,clientId,commercialId]);
  await pool.query(schemaSql);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_day_invoice_payments WHERE operation_id=$1',[id])).rows[0].n,1);
  const locked=await pool.connect();try{await locked.query('BEGIN');await assert.rejects(assertLegacyClientDaySafe(locked,clientId,'2026-01-01'),/ancien traitement refusé/);await assert.rejects(assertLegacyDayInvoiceReferenceSafe(locked),/ancienne référence/);await locked.query('ROLLBACK');}finally{locked.release();}
 }finally{await pool?.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
