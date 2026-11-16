import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {dayInvoiceReferenceCacheSchema,saveDayInvoiceReference,readDayInvoiceReferenceCache} from '../../../apps/mobile/day-invoice-reference-cache.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',invoiceId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',saleId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const identity={commercialId:clientId,serverOrigin:'https://example.test'};
const payment={operationId:'11111111-1111-4111-8111-111111111111',clientId,day:'2026-01-01',recordedAt:'2026-01-01T12:00:00.000Z',amount:200000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]};
const old={version:6,clients:[{id:clientId,name:'Client',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'250000'}],articles:[],saleStates:[{saleId,clientId,version:1,total:'250000',paid:'0'}],settlementStates:[],settlementDays:[],settlementProofs:[],saleDays:[{saleId,clientId,day:'2026-01-01'}],journalStates:[{id:invoiceId,clientId,journalDate:'2026-01-01',total:600000,receipts:[],declaredByDayPayment:false}],journalProofs:[{id:invoiceId,version:1,hash:'a'.repeat(64)}],dayPayments:[]};
const next={...old,clients:[{...old.clients[0],serverBalance:'650000'}],journalStates:[{...old.journalStates[0],declaredByDayPayment:true}],dayPayments:[payment]};
function setup(){const db=new DatabaseSync(':memory:');db.exec(`${identifiedDeviceSchema}${creditReferencePrototypeSchema}${dayInvoiceReferenceCacheSchema}`);db.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(identity.commercialId,identity.serverOrigin);
 const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};return {db,tx};}
test('cache v6 séparé : avance, rejette capture périmée et conserve les paiements',async()=>{const {db,tx}=setup();try{
 await saveDayInvoiceReference(tx,identity,identity,old);await saveDayInvoiceReference(tx,identity,identity,next);
 assert.equal((await readDayInvoiceReferenceCache(tx,identity))?.dayPayments.length,1);
 await assert.rejects(saveDayInvoiceReference(tx,identity,identity,old),/Paiement serveur périmé/);
 assert.equal((await readDayInvoiceReferenceCache(tx,identity))?.dayPayments[0].amount,200000);
 const moved={...next,saleDays:[{...next.saleDays[0],day:'2026-01-02'}],dayPayments:[] ,journalStates:[{...next.journalStates[0],declaredByDayPayment:false}]};await assert.rejects(saveDayInvoiceReference(tx,identity,identity,moved),/Journée de vente/);
 const altered={...next,dayPayments:[{...payment,amount:199999}]};await assert.rejects(saveDayInvoiceReference(tx,identity,identity,altered),/Paiement serveur périmé/);
 }finally{db.close();}});
test('cache v6 : v4 conservé et contrôle des preuves antérieures, v5 jamais écrasé',async()=>{const {db,tx}=setup();try{
 const v4={...old,version:4};db.prepare('INSERT INTO identified_reference_cache VALUES(1,?,?,?)').run(identity.commercialId,identity.serverOrigin,JSON.stringify(v4));
 await saveDayInvoiceReference(tx,identity,identity,old);
 await assert.rejects(saveDayInvoiceReference(tx,identity,identity,{...old,journalProofs:[{...old.journalProofs[0],hash:'b'.repeat(64)}]}),/Facture serveur périmée/);
 assert.equal((db.prepare('SELECT payload FROM identified_reference_cache').get() as {payload:string}).payload,JSON.stringify(v4));
 db.prepare('INSERT INTO credit_reference_prototype_cache VALUES(1,?,?,?)').run(identity.commercialId,identity.serverOrigin,'{}');
 await assert.rejects(saveDayInvoiceReference(tx,identity,identity,next),/Cache v5/);await assert.rejects(readDayInvoiceReferenceCache(tx,identity),/Cache v5/);
 assert.equal((db.prepare('SELECT payload FROM credit_reference_prototype_cache').get() as {payload:string}).payload,'{}');
 }finally{db.close();}});
test('cache v6 : refuse identité ou origine différente sans écriture',async()=>{const {db,tx}=setup();try{
 await assert.rejects(saveDayInvoiceReference(tx,identity,{...identity,serverOrigin:'https://other.test'},old),/Session/);
 await assert.rejects(readDayInvoiceReferenceCache(tx,{...identity,serverOrigin:'https://other.test'}),/Identité/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM day_invoice_reference_cache').get()?.n,0);
 }finally{db.close();}});

test('cache v6 : une preuve de règlement connue ne peut ni disparaître ni changer',async()=>{
 const {db,tx}=setup();try{
  const id='33333333-3333-4333-8333-333333333333',p={operationId:id,clientId};
  const withDebt={...old,settlementStates:[p],settlementDays:[{...p,day:'2026-01-01'}],settlementProofs:[{operationId:id,hash:'a'.repeat(64)}]};
  await saveDayInvoiceReference(tx,identity,identity,withDebt);
  await assert.rejects(saveDayInvoiceReference(tx,identity,identity,{...withDebt,settlementProofs:[{operationId:id,hash:'b'.repeat(64)}]}),/Preuve de règlement/);
  await assert.rejects(saveDayInvoiceReference(tx,identity,identity,old),/Règlement serveur périmé/);
 }finally{db.close();}
});

test('cache v6 : marqueur de dette immuable, aucune reclassification rétroactive',async()=>{
 const {db,tx}=setup();try{
  const id='33333333-3333-4333-8333-333333333333',p={operationId:id,clientId};
  const unmarked={...old,settlementStates:[p],settlementDays:[{...p,day:'2026-01-01'}],settlementProofs:[{operationId:id,hash:'a'.repeat(64)}]};
  const marked={...unmarked,oldDebtMarkers:[{operationId:id,invoiceDay:'2026-01-01'}]};
  await saveDayInvoiceReference(tx,identity,identity,unmarked);
  await assert.rejects(saveDayInvoiceReference(tx,identity,identity,marked),/Classification rétroactive/);
  db.exec('DELETE FROM day_invoice_reference_cache');
  await saveDayInvoiceReference(tx,identity,identity,marked);
  await assert.rejects(saveDayInvoiceReference(tx,identity,identity,unmarked),/Marqueur de dette périmé/);
 }finally{db.close();}
});

test('preuves complètes de vente : migration, immutabilité et nouvelle version',async()=>{
 const {db,tx}=setup();try{
  const proved={...old,saleProofs:[{saleId,version:1,hash:'a'.repeat(64)}]};
  await saveDayInvoiceReference(tx,identity,identity,old);await saveDayInvoiceReference(tx,identity,identity,proved);
  assert.equal((await readDayInvoiceReferenceCache(tx,identity))?.hasSaleProofs,true);
  await assert.rejects(saveDayInvoiceReference(tx,identity,identity,old),/Preuves de vente absentes/);
  await assert.rejects(saveDayInvoiceReference(tx,identity,identity,{...proved,saleProofs:[{saleId,version:1,hash:'b'.repeat(64)}]}),/Preuve de vente périmée/);
  await assert.rejects(saveDayInvoiceReference(tx,identity,identity,{...proved,saleProofs:[]}),/incomplètes/);
  const newer={...proved,saleStates:[{...old.saleStates[0],version:2}],saleProofs:[{saleId,version:2,hash:'b'.repeat(64)}]};
  await saveDayInvoiceReference(tx,identity,identity,newer);assert.equal((await readDayInvoiceReferenceCache(tx,identity))?.saleProofs[0].version,2);
 }finally{db.close();}
});
