import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {dayInvoiceReferenceCacheSchema} from '../../../apps/mobile/day-invoice-reference-cache.js';
import {isolatedDayInvoiceSetupSchema,initializeIsolatedDayInvoice,readIsolatedDayInvoiceSetup,assertIsolatedDayInvoicePin} from '../../../apps/mobile/day-invoice-isolated-setup.js';
const identity={commercialId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',serverOrigin:'https://example.test'};
const pin={...identity,lineageId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
const setup={identity,pin,name:'Commercial fictif'};
const reference={version:6,clients:[],articles:[],saleStates:[],settlementStates:[],settlementDays:[],settlementProofs:[],saleDays:[],journalStates:[],journalProofs:[],dayPayments:[]};
function make(){const db=new DatabaseSync(':memory:');db.exec(`${identifiedDeviceSchema}${creditReferencePrototypeSchema}${dayInvoiceReferenceCacheSchema}${isolatedDayInvoiceSetupSchema}
 CREATE TABLE sales(id INTEGER);CREATE TABLE sale_revisions(id INTEGER);CREATE TABLE settlements(id INTEGER);CREATE TABLE tour_pre_invoices(id TEXT);CREATE TABLE tour_journal_receipts(id INTEGER);CREATE TABLE sales_outbox(id INTEGER);CREATE TABLE journal_sync_outbox(id INTEGER);CREATE TABLE journal_sync_state(invoice_id TEXT);CREATE TABLE reference_snapshot(id INTEGER);CREATE TABLE day_invoice_payments(id INTEGER);CREATE TABLE day_invoice_compensation_local(id INTEGER);`);
 const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p);}};
 const initialize=async(value=setup,ref:unknown=reference,check=()=>{})=>{db.exec('BEGIN');try{const result=await initializeIsolatedDayInvoice(tx,value,ref,check);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
 return {db,tx,initialize};}
test('banc isolé : liaison atomique et lignée immuable',async()=>{const {db,tx,initialize}=make();try{
 assert.equal(await readIsolatedDayInvoiceSetup(tx),null);assert.deepEqual(await initialize(),setup);assert.deepEqual(await readIsolatedDayInvoiceSetup(tx),setup);
 assertIsolatedDayInvoicePin(setup,pin);assert.throws(()=>assertIsolatedDayInvoicePin(setup,{...pin,lineageId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}),/Lignée serveur différente/);
 await assert.rejects(initialize(),/déjà initialisée/);assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,1);
 }finally{db.close();}});
test('banc isolé : refuse des données préexistantes et annule une référence invalide',async()=>{const {db,tx,initialize}=make();try{
 db.exec('INSERT INTO sales VALUES(1)');await assert.rejects(initialize(),/non vide/);assert.equal(await readIsolatedDayInvoiceSetup(tx),null);db.exec('DELETE FROM sales');
 await assert.rejects(initialize(setup,{version:5}));assert.equal(await readIsolatedDayInvoiceSetup(tx),null);assert.equal(db.prepare('SELECT count(*) AS n FROM identified_device').get()?.n,0);
 let calls=0;await assert.rejects(initialize(setup,reference,()=>{if(++calls===3)throw Error('interruption');}),/interruption/);assert.equal(await readIsolatedDayInvoiceSetup(tx),null);assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,0);
 }finally{db.close();}});
test('banc isolé : aucun registre orphelin ou futur ne peut être ignoré',async()=>{const {db,tx,initialize}=make();try{
 db.exec('CREATE TABLE day_invoice_sale_attempt(id INTEGER); INSERT INTO day_invoice_sale_attempt VALUES(1)');
 await assert.rejects(initialize(),/non vide/);assert.equal(await readIsolatedDayInvoiceSetup(tx),null);
 db.exec('DELETE FROM day_invoice_sale_attempt; CREATE TABLE "nouveau\"\"registre"(id INTEGER); INSERT INTO "nouveau\"\"registre" VALUES(1)');
 await assert.rejects(initialize(),/non vide/);assert.equal(db.prepare('SELECT count(*) AS n FROM "nouveau\"\"registre"').get()?.n,1);
 }finally{db.close();}});
test('banc isolé : refuse liaison partielle ou identité de lignée différente',async()=>{const {db,tx,initialize}=make();try{
 await assert.rejects(initialize({...setup,pin:{...pin,commercialId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}}),/invalide/);
 db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);await assert.rejects(readIsolatedDayInvoiceSetup(tx),/incomplète/);
 }finally{db.close();}});
