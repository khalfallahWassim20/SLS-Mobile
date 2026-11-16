import {readEditableDaySale} from '../../../apps/mobile/day-invoice-sale-edit-read.js';
import {dayInvoiceCompensationLocalSchema,confirmLocalCompensation,readLocalCompensation,acknowledgeLocalCompensation} from '../../../apps/mobile/day-invoice-compensation-local.js';
import {readLocalCompensationView,readLocalCompensationCollectionImpact} from '../../../apps/mobile/day-invoice-compensation-view.js';
import {synchronizeLocalCompensation} from '../../../apps/mobile/day-invoice-compensation-sync.js';
import {readDayInvoiceClients} from '../../../apps/mobile/day-invoice-clients.js';
import {dayInvoiceSaleEditAttemptSchema,prepareSaleEditAttempt,readSaleEditAttempt,confirmSaleEditAttempt,acknowledgeSaleEditAttempt,cancelSaleEditAttempt} from '../../../apps/mobile/day-invoice-sale-edit-attempt.js';
import {assertDayInvoiceAttemptsSettled} from '../../../apps/mobile/day-invoice-attempt-guard.js';
import {assertLegacyMobileDayInvoiceSafe} from '../../../apps/mobile/day-invoice-legacy-guard.js';
import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';import {tourCloseQueueSchema} from '../../../apps/mobile/tour-close-queue.js';import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';import {offlineCreditPrototypeSchema} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference} from '../../../apps/mobile/day-invoice-reference-cache.js';import {dayInvoiceQueueSchema} from '../../../apps/mobile/day-invoice-queue.js';import {saleEventTimeSchema} from '../../../apps/mobile/sale-event-time.js';
import {draftSaleLines,parseSaleEditLines} from '../../../apps/mobile/day-invoice-sale-edit-input.js';
import {captureDayInvoiceSaleEdit,confirmDayInvoiceSaleEdit} from '../../../apps/mobile/day-invoice-sale-edit.js';import {captureDayInvoiceForm,confirmDayInvoiceForm} from '../../../apps/mobile/day-invoice-form.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',saleId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',invoiceId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',identity={commercialId:clientId,serverOrigin:'https://example.test'},day='2026-01-01',at='2026-01-01T09:00:00.000Z';
const saleOperation='11111111-1111-4111-8111-111111111111',editOperation='22222222-2222-4222-8222-222222222222',paymentOperation='33333333-3333-4333-8333-333333333333';
const line={name:'Produit',code:'X',quantity:5,unitPrice:50000,discount:0,vat:0},sale={createdAt:at,clientId,clientName:'Client',syncSaleId:saleId,syncVersion:1,lines:[line],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
const payment={operationId:paymentOperation,clientId,day,recordedAt:at,amount:800000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]};
const reference={version:6,clients:[{id:clientId,name:'Client',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'50000'}],articles:[],saleStates:[{saleId,clientId,version:1,total:'250000',paid:'0'}],saleDays:[{saleId,clientId,day}],settlementStates:[],settlementDays:[],settlementProofs:[],oldDebtMarkers:[],journalStates:[{id:invoiceId,clientId,journalDate:day,total:600000,receipts:[],declaredByDayPayment:true}],journalProofs:[{id:invoiceId,version:1,hash:'a'.repeat(64)}],dayPayments:[payment]};
const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');
function setup(){const db=new DatabaseSync(':memory:');db.exec(`${identifiedDeviceSchema}${tourCloseQueueSchema}${creditReferencePrototypeSchema}${offlineCreditPrototypeSchema}${dayInvoiceReferenceCacheSchema}${dayInvoiceQueueSchema}${saleEventTimeSchema}${dayInvoiceSaleEditAttemptSchema}
 CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
 CREATE TABLE sale_revisions(id INTEGER PRIMARY KEY,sale_id INTEGER,created_at TEXT,previous_payload TEXT,new_payload TEXT,refund INTEGER);
 CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,payload TEXT);
 CREATE TABLE tour_pre_invoices(id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE journal_sync_state(invoice_id TEXT,version INTEGER,payload TEXT);`);
 db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);db.prepare('INSERT INTO sales VALUES(1,?,?)').run(clientId,JSON.stringify(sale));db.prepare("INSERT INTO identified_local_operations VALUES(?,?,'sale',?,?)").run(saleOperation,clientId,saleId,at);
 const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,getAllAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).all(...p) as T[],runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};return {db,tx};}
test('révision v6 hors ligne : aperçu combiné, trop-perçu refusé et écriture atomique',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  const draft=draftSaleLines([line]);draft[0].quantity='6';const increase=parseSaleEditLines(draft),preview=await captureDayInvoiceSaleEdit(tx,identity,1,increase,digest);assert.equal(preview.assessment.total,900000);assert.equal(preview.assessment.paid,800000);assert.equal(preview.assessment.remaining,100000);assert.equal(preview.balanceAfter,100000);
  const decrease=[{...line,quantity:3}],danger=await captureDayInvoiceSaleEdit(tx,identity,1,decrease,digest);assert.equal(danger.assessment.excess,50000);assert.equal(danger.assessment.requiresChoice,true);assert.deepEqual(danger.excessPlan?.options,[{choice:'refund',refundAmount:50000,creditAmount:0,balanceAfter:0},{choice:'credit',refundAmount:0,creditAmount:50000,balanceAfter:-50000}]);assert.equal(db.prepare('SELECT count(*) n FROM sale_revisions').get()?.n,0);
  db.exec('BEGIN');await assert.rejects(confirmDayInvoiceSaleEdit(tx,identity,{saleId:1,lines:decrease,fingerprint:danger.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'},digest),/remboursement ou crédit/);db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) n FROM sale_revisions').get()?.n,0);
  db.exec('BEGIN');await assert.rejects(confirmDayInvoiceSaleEdit(tx,identity,{saleId:1,lines:increase,fingerprint:'périmé',operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'},digest),/changé/);db.exec('ROLLBACK');
  db.exec('BEGIN');const result=await confirmDayInvoiceSaleEdit(tx,identity,{saleId:1,lines:increase,fingerprint:preview.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'},digest);db.exec('COMMIT');
  assert.equal(result.updated.total,300000);assert.equal(result.updated.syncVersion,2);assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,1);assert.equal(db.prepare('SELECT count(*) n FROM sale_revisions').get()?.n,1);
  await assert.rejects(captureDayInvoiceSaleEdit(tx,identity,1,increase,digest),/Opérations en attente/);
  const after=await captureDayInvoiceForm(tx,identity,clientId,day,digest);assert.equal(after.view.total,900000);assert.equal(after.view.remaining,100000);
  const extraPayment='44444444-4444-4444-8444-444444444444';
  db.exec('BEGIN');await confirmDayInvoiceForm(tx,identity,{clientId,day,fingerprint:after.fingerprint,operationId:extraPayment,recordedAt:'2026-01-01T10:01:00.000Z',amount:50000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''},digest);db.exec('COMMIT');
  assert.equal((await captureDayInvoiceForm(tx,identity,clientId,day,digest)).view.remaining,50000);
  assert.equal(db.prepare('SELECT count(*) n FROM day_invoice_payment_outbox').get()?.n,1);
 }finally{db.close();}
});
test('révision v6 : source, identité, lignes et opérations en attente sont contrôlées',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  await assert.rejects(captureDayInvoiceSaleEdit(tx,{...identity,serverOrigin:'https://other.test'},1,[line],digest),/Identité/);
  await assert.rejects(captureDayInvoiceSaleEdit(tx,identity,1,[{...line,unitPrice:1}],digest),/Article/);
  db.prepare('UPDATE sales SET payload=?').run(JSON.stringify({...sale,total:249000}));await assert.rejects(captureDayInvoiceSaleEdit(tx,identity,1,[line],digest),/incohérentes/);
  db.prepare('UPDATE sales SET payload=?').run(JSON.stringify(sale));db.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(editOperation,saleId,2,'{}');
  await assert.rejects(captureDayInvoiceSaleEdit(tx,identity,1,[line],digest),/identité vérifiée/);
 }finally{db.close();}
});
test('révision v6 : toute erreur pendant l’écriture annule vente, historique et file',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  const lines=[{...line,quantity:6}],preview=await captureDayInvoiceSaleEdit(tx,identity,1,lines,digest);
  const failing={...tx,runAsync:async(sql:string,...args:(string|number|null)[])=>{if(sql.startsWith('INSERT INTO sales_outbox'))throw Error('échec simulé');await tx.runAsync(sql,...args);}};
  db.exec('BEGIN');await assert.rejects(confirmDayInvoiceSaleEdit(failing,identity,{saleId:1,lines,fingerprint:preview.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'},digest),/échec simulé/);db.exec('ROLLBACK');
  assert.deepEqual(JSON.parse(String(db.prepare('SELECT payload FROM sales WHERE id=1').get()?.payload)),sale);
  for(const table of ['sale_revisions','sales_outbox','sale_event_times'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM identified_local_operations WHERE operation_id=?').get(editOperation)?.n,0);
  const fresh=await captureDayInvoiceSaleEdit(tx,identity,1,lines,digest);assert.equal(fresh.fingerprint,preview.fingerprint);
  db.exec('BEGIN');await confirmDayInvoiceSaleEdit(tx,identity,{saleId:1,lines,fingerprint:fresh.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'},digest);db.exec('COMMIT');
 }finally{db.close();}
});

test('révision en attente : preuve locale altérée ou file disparue bloque la projection',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  const lines=[{...line,quantity:6}],preview=await captureDayInvoiceSaleEdit(tx,identity,1,lines,digest);
  await confirmDayInvoiceSaleEdit(tx,identity,{saleId:1,lines,fingerprint:preview.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'},digest);
  assert.equal((await captureDayInvoiceForm(tx,identity,clientId,day,digest)).view.remaining,100000);
  const queued=String(db.prepare('SELECT payload FROM sales_outbox').get()?.payload),event=JSON.parse(queued);
  db.prepare('UPDATE sales_outbox SET payload=?').run(JSON.stringify({...event,refund:1}));await assert.rejects(captureDayInvoiceForm(tx,identity,clientId,day,digest),/incohérentes/);
  db.prepare('UPDATE sales_outbox SET payload=?').run(queued);
  // Même si trois copies locales sont altérées ensemble, le paiement initial
  // ne peut pas être changé sous prétexte d'une révision sans remboursement.
  const originalCurrent=String(db.prepare('SELECT payload FROM sales').get()?.payload),originalRevision=String(db.prepare('SELECT new_payload FROM sale_revisions').get()?.new_payload);
  const modifiedSale={...JSON.parse(originalCurrent),paid:1000,remaining:299000},modifiedRevision={...JSON.parse(originalRevision),paid:1000,remaining:299000};
  db.prepare('UPDATE sales SET payload=?').run(JSON.stringify(modifiedSale));db.prepare('UPDATE sale_revisions SET new_payload=?').run(JSON.stringify(modifiedRevision));db.prepare('UPDATE sales_outbox SET payload=?').run(JSON.stringify({...event,sale:modifiedSale}));
  await assert.rejects(captureDayInvoiceForm(tx,identity,clientId,day,digest),/incohérentes/);
  db.prepare('UPDATE sales SET payload=?').run(originalCurrent);db.prepare('UPDATE sale_revisions SET new_payload=?').run(originalRevision);db.prepare('UPDATE sales_outbox SET payload=?').run(queued);
  db.prepare('UPDATE sale_revisions SET refund=1').run();await assert.rejects(captureDayInvoiceForm(tx,identity,clientId,day,digest),/incohérentes/);
  db.prepare('UPDATE sale_revisions SET refund=0').run();db.prepare('DELETE FROM sales_outbox').run();await assert.rejects(captureDayInvoiceForm(tx,identity,clientId,day,digest),/incohérentes/);
 }finally{db.close();}
});

test('révision v6 : une opération prouvée d’un autre client ne bloque pas le travail hors ligne',async()=>{
 const {db,tx}=setup(),other='dddddddd-dddd-4ddd-8ddd-dddddddddddd',otherSale='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',otherOperation='55555555-5555-4555-8555-555555555555';
 try{
  await saveDayInvoiceReference(tx,identity,identity,{...reference,clients:[...reference.clients,{id:other,name:'Autre',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'0'}]});
  const local={...sale,clientId:other,clientName:'Autre',syncSaleId:otherSale},event={operationId:otherOperation,saleId:otherSale,version:1,sale:local,refund:0};
  db.prepare('INSERT INTO sales VALUES(2,?,?)').run(other,JSON.stringify(local));db.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(otherOperation,otherSale,1,JSON.stringify(event));db.prepare("INSERT INTO identified_local_operations VALUES(?,?,'sale',?,?)").run(otherOperation,identity.commercialId,otherSale,at);
  const forged={...event,saleId,sale:{...local,syncSaleId:saleId}};
  db.prepare('UPDATE sales_outbox SET sale_id=?,payload=?').run(saleId,JSON.stringify(forged));db.prepare('UPDATE identified_local_operations SET entity_id=? WHERE operation_id=?').run(saleId,otherOperation);
  await assert.rejects(captureDayInvoiceSaleEdit(tx,identity,1,[{...line,quantity:6}],digest),/Client de vente en attente incohérent/);
  db.prepare('UPDATE sales_outbox SET sale_id=?,payload=?').run(otherSale,JSON.stringify(event));db.prepare('UPDATE identified_local_operations SET entity_id=? WHERE operation_id=?').run(otherSale,otherOperation);
  const lines=[{...line,quantity:6}],preview=await captureDayInvoiceSaleEdit(tx,identity,1,lines,digest);assert.equal(preview.balanceAfter,100000);
  db.exec('BEGIN');await confirmDayInvoiceSaleEdit(tx,identity,{saleId:1,lines,fingerprint:preview.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'},digest);db.exec('COMMIT');
  assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,2);
  assert.equal((await captureDayInvoiceForm(tx,identity,clientId,day,digest)).view.remaining,100000);
  await assert.rejects(captureDayInvoiceSaleEdit(tx,identity,1,lines,digest),/Opérations en attente pour ce client/);
 }finally{db.close();}
});

test('révision durable : reprise après réponse perdue, preuve et garde de clôture',async()=>{
 const {db,tx}=setup();try{
  await saveDayInvoiceReference(tx,identity,identity,reference);
  const lines=[{...line,quantity:6}],preview=await captureDayInvoiceSaleEdit(tx,identity,1,lines,digest);
  const attempt={saleId:1,clientId,day,lines,fingerprint:preview.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'};
  db.exec('BEGIN');await prepareSaleEditAttempt(tx,identity,attempt,digest);db.exec('COMMIT');
  assert.equal((await readSaleEditAttempt(tx,identity))?.result,null);
  await assert.rejects(assertDayInvoiceAttemptsSettled(tx,identity),/Modification en attente/);
  await assert.rejects(assertDayInvoiceAttemptsSettled(tx,identity,day),/Modification en attente/);
  await assertDayInvoiceAttemptsSettled(tx,identity,'2026-01-02');
  await assert.rejects(assertLegacyMobileDayInvoiceSafe(tx),/facture du jour|Modification/);
  await assert.rejects(prepareSaleEditAttempt(tx,identity,{...attempt,operationId:paymentOperation},digest),/autre modification/);
  db.exec('BEGIN');const result=await confirmSaleEditAttempt(tx,identity,editOperation,digest);db.exec('COMMIT');
  // Le résultat a pu être perdu après COMMIT ; la reprise ne crée pas une deuxième révision.
  assert.deepEqual(await confirmSaleEditAttempt(tx,identity,editOperation,digest),result);
  assert.equal(result.updated.total,300000);assert.equal((await captureDayInvoiceForm(tx,identity,clientId,day,digest)).view.remaining,100000);
  assert.equal(db.prepare('SELECT count(*) n FROM sale_revisions').get()?.n,1);
  await assertDayInvoiceAttemptsSettled(tx,identity);
  await assert.rejects(cancelSaleEditAttempt(tx,identity,editOperation),/non abandonnable/);
  const original=String(db.prepare('SELECT new_payload FROM sale_revisions').get()?.new_payload);
  db.prepare('UPDATE sale_revisions SET new_payload=?').run('{}');
  await assert.rejects(readSaleEditAttempt(tx,identity),/Preuve de modification incohérente/);
  await assert.rejects(acknowledgeSaleEditAttempt(tx,identity,editOperation),/Preuve de modification incohérente/);
  db.prepare('UPDATE sale_revisions SET new_payload=?').run(original);
  await acknowledgeSaleEditAttempt(tx,identity,editOperation);assert.equal(await readSaleEditAttempt(tx,identity),null);
 }finally{db.close();}
});

test('révision durable : échec atomique et abandon sans effacer une trace',async()=>{
 const {db,tx}=setup();try{
  await saveDayInvoiceReference(tx,identity,identity,reference);
  const lines=[{...line,quantity:6}],preview=await captureDayInvoiceSaleEdit(tx,identity,1,lines,digest);
  const attempt={saleId:1,clientId,day,lines,fingerprint:preview.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'};
  await prepareSaleEditAttempt(tx,identity,attempt,digest);
  const failing={...tx,runAsync:async(sql:string,...args:(string|number|null)[])=>{if(sql.startsWith('UPDATE day_invoice_sale_edit_attempt'))throw Error('panne simulée');await tx.runAsync(sql,...args);}};
  db.exec('BEGIN');await assert.rejects(confirmSaleEditAttempt(failing,identity,editOperation,digest),/panne simulée/);db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) n FROM sale_revisions').get()?.n,0);assert.equal((await readSaleEditAttempt(tx,identity))?.result,null);
  db.prepare("INSERT INTO identified_local_operations VALUES(?,?,'sale',?,?)").run(editOperation,clientId,saleId,attempt.recordedAt);
  await assert.rejects(cancelSaleEditAttempt(tx,identity,editOperation),/Trace/);db.prepare('DELETE FROM identified_local_operations WHERE operation_id=?').run(editOperation);
  await cancelSaleEditAttempt(tx,identity,editOperation);assert.equal(await readSaleEditAttempt(tx,identity),null);
  const dangerLines=[{...line,quantity:3}],danger=await captureDayInvoiceSaleEdit(tx,identity,1,dangerLines,digest);
  await assert.rejects(prepareSaleEditAttempt(tx,identity,{...attempt,lines:dangerLines,fingerprint:danger.fingerprint},digest),/remboursement ou crédit/);
 }finally{db.close();}
});


test('sélection de vente : vérifie client, journée, référence et opérations en attente',async()=>{
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  assert.equal((await readEditableDaySale(tx,identity,clientId,day,1,digest)).syncSaleId,saleId);
  await assert.rejects(readEditableDaySale(tx,identity,'dddddddd-dddd-4ddd-8ddd-dddddddddddd',day,1,digest),/autre client/);
  await assert.rejects(readEditableDaySale(tx,identity,clientId,'2026-01-02',1,digest),/autre journée/);
  db.prepare('UPDATE sales SET payload=? WHERE id=1').run(JSON.stringify({...sale,total:1}));
  await assert.rejects(readEditableDaySale(tx,identity,clientId,day,1,digest),/incohérentes/);
 }finally{db.close();}
});

test('parcours expérimental : édition, reprise depuis le registre et facture mise à jour',async()=>{
 const {captureWorkspaceState}=await import('../../../apps/mobile/day-invoice-workspace-state.js');
 const {resumeSaleEditAttempt,finishSaleEditAttempt}=await import('../../../apps/mobile/day-invoice-sale-edit-attempt-flow.js');
 const {db,tx}=setup();try{await saveDayInvoiceReference(tx,identity,identity,reference);
  const selected=await readEditableDaySale(tx,identity,clientId,day,1,digest),lines=selected.lines.map(l=>({...l,quantity:6}));
  const preview=await captureDayInvoiceSaleEdit(tx,identity,selected.id,lines,digest);
  const attempt={saleId:selected.id,clientId,day,lines,fingerprint:preview.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z'};
  db.exec('BEGIN');await prepareSaleEditAttempt(tx,identity,attempt,digest);db.exec('COMMIT');
  const state=()=>captureWorkspaceState({preinvoice:async()=>null,sale:async()=>null,saleEdit:()=>readSaleEditAttempt(tx,identity),payment:async()=>null,oldDebt:async()=>null,clients:async()=>['client']});
  assert.deepEqual(await state(),{pending:{kind:'saleEdit',clientId,day,saleId:1},clients:null});
  const transaction=async<T>(f:()=>Promise<T>)=>{db.exec('BEGIN');try{const value=await f();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
  const io={read:()=>transaction(()=>readSaleEditAttempt(tx,identity)),prepare:(a:typeof attempt)=>transaction(()=>prepareSaleEditAttempt(tx,identity,a,digest)),confirm:(id:string)=>transaction(()=>confirmSaleEditAttempt(tx,identity,id,digest)),acknowledge:(id:string)=>transaction(()=>acknowledgeSaleEditAttempt(tx,identity,id)),cancel:(id:string)=>transaction(()=>cancelSaleEditAttempt(tx,identity,id))};
  const stored=await resumeSaleEditAttempt(io,attempt);assert.equal(stored.result?.assessment.total,900000);assert.equal(stored.result?.assessment.remaining,100000);
  assert.equal((await state()).pending?.kind,'saleEdit');await finishSaleEditAttempt(io,attempt);assert.deepEqual(await state(),{pending:null,clients:['client']});
  assert.equal((await captureDayInvoiceForm(tx,identity,clientId,day,digest)).view.remaining,100000);
 }finally{db.close();}
});

for(const choice of ['refund','credit'] as const)test(`compensation locale ${choice} : écriture atomique, reprise et garde`,async()=>{
 const {db,tx}=setup();try{
  db.exec(dayInvoiceCompensationLocalSchema);await saveDayInvoiceReference(tx,identity,identity,reference);
  const lines=[{...line,quantity:3}],preview=await captureDayInvoiceSaleEdit(tx,identity,1,lines,digest);
  const input={saleId:1,lines,fingerprint:preview.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z',choice};
  await assert.rejects(confirmLocalCompensation(tx,identity,{...input,fingerprint:'périmé'},digest),/modifié/);
  await assert.rejects(confirmLocalCompensation(tx,identity,{...input,recordedAt:at},digest),/Date/);
  await assert.rejects(confirmLocalCompensation(tx,{...identity,serverOrigin:'https://autre.test'},input,digest),/Identité/);
  const fail={...tx,runAsync:async(sql:string,...p:(string|number|null)[])=>{if(sql.startsWith('INSERT INTO day_invoice_compensation_local'))throw Error('échec simulé');await tx.runAsync(sql,...p);}};
  db.exec('BEGIN');await assert.rejects(confirmLocalCompensation(fail,identity,input,digest),/échec simulé/);db.exec('ROLLBACK');
  assert.deepEqual(JSON.parse(String(db.prepare('SELECT payload FROM sales WHERE id=1').get()?.payload)),sale);
  for(const table of ['sale_revisions','sales_outbox','sale_event_times','day_invoice_compensation_local'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n,0);
  db.exec('BEGIN');const result=await confirmLocalCompensation(tx,identity,input,digest);db.exec('COMMIT');
  assert.equal(result.status,'created');assert.equal(db.prepare('SELECT count(*) n FROM sales_outbox').get()?.n,0);
  assert.equal((JSON.parse(String(db.prepare('SELECT payload FROM sales WHERE id=1').get()?.payload))).total,150000);
  assert.equal((await confirmLocalCompensation(tx,identity,input,digest)).status,'duplicate');
  const view=await readLocalCompensationView(tx,identity);assert.ok(view);assert.equal(view.syncStatus,'pending');assert.equal(view.localBalanceBefore,50000);assert.equal(view.localBalanceAfter,choice==='refund'?0:-50000);assert.equal(view.serverBalanceAtReceipt,null);assert.equal(view.balanceNeedsReview,null);
  assert.deepEqual(await readLocalCompensationCollectionImpact(tx,identity,identity.commercialId,day),{refund:choice==='refund'?50000:0,credit:choice==='credit'?50000:0,netCollectedChange:choice==='refund'?-50000:0,operationId:editOperation,syncStatus:'pending'});
  assert.equal((await readLocalCompensationCollectionImpact(tx,identity,identity.commercialId,'2026-01-02')).operationId,null);
  assert.equal((await readLocalCompensationCollectionImpact(tx,identity,saleId,day)).operationId,null);
  await assert.rejects(confirmLocalCompensation(tx,identity,{...input,choice:choice==='refund'?'credit':'refund'},digest),/différente/);
  await assert.rejects(captureDayInvoiceForm(tx,identity,clientId,day,digest),/Compensation/);
  await assert.rejects(readDayInvoiceClients(tx,identity,digest),/Compensation/);
  await assert.rejects(assertLegacyMobileDayInvoiceSafe(tx),/Compensation/);
  await assert.rejects(assertDayInvoiceAttemptsSettled(tx,identity),/Compensation/);
  const payload=JSON.parse(result.payload),projection={operationId:editOperation,clientId,commercialId:identity.commercialId,invoiceDay:day,eventDay:day,recordedAt:input.recordedAt,choice,compensation:50000,total:750000,paidBeforeCompensation:800000,applied:750000,remaining:0,balance:choice==='refund'?0:-50000,refund:choice==='refund'?50000:0,credit:choice==='credit'?50000:0};
  const receipt={...payload,projection};
  await assert.rejects(acknowledgeLocalCompensation(tx,identity,result.payload,{...receipt,projection:{...projection,compensation:1}}),/divergente/);
  await acknowledgeLocalCompensation(tx,identity,result.payload,receipt);assert.deepEqual((await readLocalCompensation(tx,identity))?.receipt,receipt);
  const proven=await readLocalCompensationView(tx,identity);assert.equal(proven?.syncStatus,'proven');assert.equal(proven?.balanceNeedsReview,false);
  db.prepare('UPDATE day_invoice_compensation_local SET receipt=?').run(JSON.stringify({...receipt,projection:{...projection,balance:projection.balance+1}}));
  const differing=await readLocalCompensationView(tx,identity);assert.equal(differing?.balanceNeedsReview,true);assert.equal(differing?.serverBalanceAtReceipt,projection.balance+1);
  db.prepare('UPDATE day_invoice_compensation_local SET receipt=?').run(JSON.stringify(receipt));
  await assertLegacyMobileDayInvoiceSafe(tx).then(()=>assert.fail('garde levée'),e=>assert.match(String(e),/Compensation/));
  db.prepare('UPDATE sale_revisions SET refund=1').run();await assert.rejects(readLocalCompensation(tx,identity),/incohérente/);
 }finally{db.close();}
});

test('synchronisation compensation : session révoquée annule le reçu et reprise',async()=>{
 const {db,tx}=setup();try{
  db.exec(dayInvoiceCompensationLocalSchema);await saveDayInvoiceReference(tx,identity,identity,reference);
  const lines=[{...line,quantity:3}],preview=await captureDayInvoiceSaleEdit(tx,identity,1,lines,digest),input={saleId:1,lines,fingerprint:preview.fingerprint,operationId:editOperation,recordedAt:'2026-01-01T10:00:00.000Z',choice:'refund' as const};
  const saved=await confirmLocalCompensation(tx,identity,input,digest),payload=JSON.parse(saved.payload);
  const proof={...payload,projection:{operationId:editOperation,clientId,commercialId:identity.commercialId,invoiceDay:day,eventDay:day,recordedAt:input.recordedAt,choice:'refund',compensation:50000,total:750000,paidBeforeCompensation:800000,applied:750000,remaining:0,balance:0,refund:50000,credit:0}};
  let revoked=false,interrupt=true,verified=0,sends=0;
  const guarded={...tx,runAsync:async(sql:string,...args:(string|number|null)[])=>{await tx.runAsync(sql,...args);if(interrupt&&sql.startsWith('UPDATE day_invoice_compensation_local SET receipt'))revoked=true;}};
  const transaction=async<T>(fn:(t:typeof tx)=>Promise<T>)=>{db.exec('BEGIN');try{const value=await fn(guarded);db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}};
  const io={transaction,check:()=>{if(revoked)throw Error('session révoquée');},verifyServer:async()=>{verified++;},send:async()=>{sends++;return {ok:true,status:200,json:async()=>({status:'duplicate',operationId:editOperation})};},receipt:async()=>({ok:true,status:200,json:async()=>proof})};
  await assert.rejects(synchronizeLocalCompensation(identity,identity,io),/session révoquée/);
  assert.equal((await readLocalCompensation(tx,identity))?.receipt,null);
  revoked=false;interrupt=false;assert.deepEqual(await synchronizeLocalCompensation(identity,identity,io),{status:'proven',operationId:editOperation});
  assert.ok((await readLocalCompensation(tx,identity))?.receipt);assert.equal(sends,2);assert.equal(verified,2);
  let resume!:()=>void;const gate=new Promise<void>(resolve=>{resume=resolve;});let waiting!:()=>void;const started=new Promise<void>(resolve=>{waiting=resolve;});
  const concurrent=synchronizeLocalCompensation(identity,identity,{...io,verifyServer:async()=>{waiting();await gate;}});await started;
  await assert.rejects(synchronizeLocalCompensation(identity,identity,io),/déjà en cours/);resume();assert.equal((await concurrent).status,'already-proven');
 }finally{db.close();}
});
