import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {dayInvoiceReferenceCacheSchema} from '../../../apps/mobile/day-invoice-reference-cache.js';
import {dayInvoiceQueueSchema} from '../../../apps/mobile/day-invoice-queue.js';
import {assertLegacyMobileDayInvoiceSafe} from '../../../apps/mobile/day-invoice-legacy-guard.js';
import {previewDayInvoiceMigration,previewDayInvoiceMigrationOnline} from '../../../apps/mobile/day-invoice-migration-preview.js';
import {assertDayInvoiceSyncIdle} from '../../../apps/mobile/day-invoice-sync-lock.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',saleId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',invoiceId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const identity={commercialId:clientId,serverOrigin:'https://example.test'},day='2026-01-01',at='2026-01-01T09:00:00.000Z';
const saleOperation='11111111-1111-4111-8111-111111111111',journalOperation='22222222-2222-4222-8222-222222222222';
const sale={createdAt:at,clientId,clientName:'Client',syncSaleId:saleId,syncVersion:1,total:250000,paid:0,remaining:250000,paymentMode:'Crédit',lines:[],chequeNumber:'',chequeBank:'',chequeDue:''};
const invoice={id:invoiceId,clientId,clientName:'Client',journalDate:day,sector:'Nord',amount:600000,createdAt:at};
const reference={version:6,clients:[{id:clientId,name:'Client',sector:'Nord',openingBalance:'0',creditLimit:'0',serverBalance:'0'}],articles:[],saleStates:[],saleDays:[],settlementStates:[],settlementDays:[],settlementProofs:[],journalStates:[],journalProofs:[],dayPayments:[]};
const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');
function setup(path=':memory:'){const db=new DatabaseSync(path);db.exec(`PRAGMA journal_mode=WAL;${identifiedDeviceSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}
 CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
 CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);
 CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);`);
 db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);
 db.prepare('INSERT INTO identified_reference_cache VALUES(1,?,?,?)').run(identity.commercialId,identity.serverOrigin,JSON.stringify({...reference,version:4}));
 const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};
 const preview=async(ref:unknown=reference,check=()=>{},verified=identity)=>{db.exec('BEGIN EXCLUSIVE');try{const v=await previewDayInvoiceMigration(tx,identity,verified,ref,digest,check);db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}};
 return {db,tx,preview};}
test('aperçu migration : anciennes opérations conservées, aucune activation, files visibles',async()=>{const {db,tx,preview}=setup();try{
 const se={operationId:saleOperation,saleId,version:1,sale,refund:0},je={operationId:journalOperation,version:1,invoice,receipts:[]};
 db.prepare('INSERT INTO sales VALUES(1,?,?)').run(clientId,JSON.stringify(sale));db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(invoiceId,clientId,day,JSON.stringify(invoice));db.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(invoiceId,1,JSON.stringify(je));
 const marker=db.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)');marker.run(saleOperation,clientId,'sale',saleId,at);marker.run(journalOperation,clientId,'journal',invoiceId,at);
 db.prepare('INSERT INTO sales_outbox VALUES(1,?,?,?)').run(saleOperation,saleId,JSON.stringify(se));db.prepare('INSERT INTO journal_sync_outbox VALUES(1,?,?,?)').run(journalOperation,invoiceId,JSON.stringify(je));
 const result=await preview();assert.equal(result.clientCount,1);assert.equal(result.pendingOperations,2);assert.deepEqual(result.conflictingClientIds,[]);assert.equal(result.migrationAuthorized,false);
 assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM sales_outbox').get()?.n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM journal_sync_outbox').get()?.n,1);assert.equal((db.prepare('SELECT payload FROM sales').get() as {payload:string}).payload,JSON.stringify(sale));await assertLegacyMobileDayInvoiceSafe(tx);
 }finally{db.close();}});
test('aperçu migration : préétablies concurrentes signalées sans modifier la file locale',async()=>{const {db,preview}=setup();try{
 const local={operationId:journalOperation,version:1,invoice,receipts:[]};
 db.prepare('INSERT INTO tour_pre_invoices VALUES(?,?,?,?)').run(invoiceId,clientId,day,JSON.stringify(invoice));db.prepare('INSERT INTO journal_sync_state VALUES(?,?,?)').run(invoiceId,1,JSON.stringify(local));
 db.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(journalOperation,clientId,'journal',invoiceId,at);db.prepare('INSERT INTO journal_sync_outbox VALUES(1,?,?,?)').run(journalOperation,invoiceId,JSON.stringify(local));
 const remoteId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';const remote={...reference,journalStates:[{id:remoteId,clientId,journalDate:day,total:700000,receipts:[],declaredByDayPayment:false}],journalProofs:[{id:remoteId,version:1,hash:'a'.repeat(64)}]};
 const result=await preview(remote);assert.deepEqual(result.conflictingClientIds,[clientId]);assert.equal(result.pendingOperations,1);assert.equal(result.migrationAuthorized,false);
 assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,0);assert.equal((db.prepare('SELECT payload FROM journal_sync_outbox').get() as {payload:string}).payload,JSON.stringify(local));
 }finally{db.close();}});
test('aperçu migration : interruption ou données locales altérées ne laissent pas de cache v6',async()=>{const {db,tx,preview}=setup();try{
 let calls=0;await assert.rejects(preview(reference,()=>{if(++calls===3)throw Error('session expirée');}),/session expirée/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,0);await assertLegacyMobileDayInvoiceSafe(tx);
 db.prepare('INSERT INTO sales VALUES(1,?,?)').run(clientId,JSON.stringify(sale));await assert.rejects(preview(),/Version de vente en attente/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM sales').get()?.n,1);await assertLegacyMobileDayInvoiceSafe(tx);
 await assert.rejects(preview(reference,()=>{},{...identity,serverOrigin:'https://other.test'}),/Session ou serveur/);
 }finally{db.close();}});
test('aperçu migration : cache temporaire jamais visible depuis une autre connexion WAL',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-preview-')),path=join(dir,'phone.db'),{db,preview}=setup(path),reader=new DatabaseSync(path);try{
 let checks=0;await preview(reference,()=>{if(++checks===3){assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,1);assert.equal(reader.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,0);}});
 assert.equal(reader.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,0);assert.equal(reader.prepare('SELECT count(*) AS n FROM identified_reference_cache').get()?.n,1);
 }finally{reader.close();db.close();rmSync(dir,{recursive:true,force:true});}});
test('aperçu migration : une erreur de rollback impose l’annulation de la transaction entière',async()=>{const {db,tx}=setup();try{
 const broken={...tx,runAsync:async(sql:string,...args:(string|number|null)[])=>{if(sql.startsWith('ROLLBACK TO'))throw Error('rollback indisponible');return tx.runAsync(sql,...args);}};
 db.exec('BEGIN EXCLUSIVE');await assert.rejects(previewDayInvoiceMigration(broken,identity,identity,reference,digest,()=>{}),/rollback indisponible/);db.exec('ROLLBACK');
 assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM identified_reference_cache').get()?.n,1);await assertLegacyMobileDayInvoiceSafe(tx);
 }finally{db.close();}});
test('aperçu migration : référence v4 indispensable et aucune régression du serveur',async()=>{const {db,preview}=setup();try{
 const previous={...reference,version:4,saleStates:[{saleId,clientId,version:1,total:'250000',paid:'0'}]};const saved=JSON.stringify(previous);
 db.prepare('UPDATE identified_reference_cache SET payload=?').run(saved);
 await assert.rejects(preview(),/Vente serveur périmée/);assert.equal((db.prepare('SELECT payload FROM identified_reference_cache').get() as {payload:string}).payload,saved);assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,0);
 db.exec('DELETE FROM identified_reference_cache');await assert.rejects(preview(),/Référence individuelle antérieure indisponible/);assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,0);
 }finally{db.close();}});
test('aperçu en ligne : ordre vérification puis lecture, verrou libéré après erreur',async()=>{const {db,tx}=setup();try{
 const calls:string[]=[];let verified=true;
 const io={check:()=>{},verifyServer:async(_identity:typeof identity,check:()=>void)=>{calls.push('lignée');check();if(!verified)throw Error('lignée refusée');},fetchReference:async()=>{calls.push('référence');return reference;},digest,transaction:async<T>(work:(value:typeof tx)=>Promise<T>)=>{calls.push('transaction');db.exec('BEGIN EXCLUSIVE');try{const v=await work(tx);db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const result=await previewDayInvoiceMigrationOnline(identity,identity,io);assert.deepEqual(calls,['lignée','référence','transaction']);assert.equal(result.migrationAuthorized,false);assertDayInvoiceSyncIdle();
 assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,0);verified=false;calls.length=0;
 await assert.rejects(previewDayInvoiceMigrationOnline(identity,identity,io),/lignée refusée/);assert.deepEqual(calls,['lignée']);assertDayInvoiceSyncIdle();
 await assert.rejects(previewDayInvoiceMigrationOnline(identity,{...identity,serverOrigin:'https://other.test'},io),/Session ou serveur/);assertDayInvoiceSyncIdle();
 }finally{db.close();}});
test('aperçu migration : ne contourne ni v5 ni les tentatives v6',async()=>{const {db,preview}=setup();try{
 db.prepare('INSERT INTO credit_reference_prototype_cache VALUES(1,?,?,?)').run(identity.commercialId,identity.serverOrigin,'{}');await assert.rejects(preview(),/Cache v5/);assert.equal(db.prepare('SELECT count(*) AS n FROM credit_reference_prototype_cache').get()?.n,1);
 db.exec('DELETE FROM credit_reference_prototype_cache;CREATE TABLE day_invoice_payment_attempt(id INTEGER);INSERT INTO day_invoice_payment_attempt VALUES(1)');await assert.rejects(preview(),/Tentative/);assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_payment_attempt').get()?.n,1);
 }finally{db.close();}});
