import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateDayInvoiceReference} from '../../../apps/mobile/day-invoice-reference.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',invoiceId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',saleId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const payment={operationId:'11111111-1111-4111-8111-111111111111',clientId,day:'2026-01-01',recordedAt:'2026-01-01T12:00:00.000Z',amount:200000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]};
const snapshot={version:6,clients:[{id:clientId,name:'Client',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'650000'}],articles:[],saleStates:[{saleId,clientId,version:1,total:'250000',paid:'0'}],settlementStates:[],settlementDays:[],settlementProofs:[],saleDays:[{saleId,clientId,day:'2026-01-01'}],journalStates:[{id:invoiceId,clientId,journalDate:'2026-01-01',total:600000,receipts:[],declaredByDayPayment:true}],journalProofs:[{id:invoiceId,version:1,hash:'a'.repeat(64)}],dayPayments:[payment]};
test('référence unifiée : conserve marqueurs, déclaration et paiement unique',()=>{const ref=validateDayInvoiceReference(snapshot);assert.equal(ref.version,6);assert.equal(ref.dayPayments[0].amount,200000);assert.deepEqual(ref.declaredByDayPayment,[invoiceId]);assert.equal(ref.clients[0].serverBalance,'650000');});
test('référence unifiée : refuse doublon, déclaration incohérente, source étrangère ou preuve périmée',()=>{
 assert.throws(()=>validateDayInvoiceReference({...snapshot,dayPayments:[payment,payment]}),/dupliqué/);
 assert.throws(()=>validateDayInvoiceReference({...snapshot,journalStates:[{...snapshot.journalStates[0],declaredByDayPayment:false}]}),/incohérente/);
 assert.throws(()=>validateDayInvoiceReference({...snapshot,dayPayments:[{...payment,preInvoice:{...payment.preInvoice,total:1}}]}),/facture/);
 assert.throws(()=>validateDayInvoiceReference({...snapshot,dayPayments:[{...payment,sales:[{id:saleId,version:2}]}]}),/vente/);
 assert.throws(()=>validateDayInvoiceReference({...snapshot,dayPayments:[{...payment,extra:'x'}]}),/invalide/);
 assert.throws(()=>validateDayInvoiceReference({...snapshot,version:4}),/invalide/);
});

import {reconcileDayInvoiceClient} from '../../../apps/mobile/day-invoice-reference.js';
const pre={id:invoiceId,clientId,clientName:'Client',sector:'',journalDate:'2026-01-01',amount:600000,createdAt:'2026-01-01T09:00:00.000Z',version:1,receipts:[]};
const sale={id:1,clientId,clientName:'Client',createdAt:'2026-01-01T09:00:00.000Z',syncSaleId:saleId,syncVersion:1,total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:'',lines:[]};
test('solde client : paiement reçu ou réponse perdue ne sont jamais déduits deux fois',()=>{
 const reference=validateDayInvoiceReference(snapshot),base={reference,clientId,localSales:[sale],localSettlements:[],localInvoices:[pre],localDayPayments:[payment]};
 assert.deepEqual(reconcileDayInvoiceClient(base),{balance:650000,pendingAmount:0});
 const old=validateDayInvoiceReference({...snapshot,clients:[{...snapshot.clients[0],serverBalance:'250000'}],journalStates:[{...snapshot.journalStates[0],declaredByDayPayment:false}],dayPayments:[]});
 assert.deepEqual(reconcileDayInvoiceClient({...base,reference:old}),{balance:650000,pendingAmount:200000});
});
test('solde client : préétablie créée hors ligne et conflit de version protégés',()=>{
 const old=validateDayInvoiceReference({...snapshot,clients:[{...snapshot.clients[0],serverBalance:'250000'}],journalStates:[],journalProofs:[],dayPayments:[]});
 const base={reference:old,clientId,localSales:[sale],localSettlements:[],localInvoices:[pre],localDayPayments:[payment]};
 assert.deepEqual(reconcileDayInvoiceClient(base),{balance:650000,pendingAmount:200000});
 assert.throws(()=>reconcileDayInvoiceClient({...base,localSales:[{...sale,syncVersion:2}]}),/modifiée/);
 assert.throws(()=>reconcileDayInvoiceClient({...base,localInvoices:[{...pre,version:2}]}),/modifiée/);
});

test('référence : journées de ventes et règlements complètes, cohérentes et non interchangeables',()=>{
 assert.throws(()=>validateDayInvoiceReference({...snapshot,saleDays:[]}),/incomplètes/);
 assert.throws(()=>validateDayInvoiceReference({...snapshot,saleDays:[{...snapshot.saleDays[0],day:'2026-02-30'}]}),/incohérente/);
 assert.throws(()=>validateDayInvoiceReference({...snapshot,saleDays:[{...snapshot.saleDays[0],day:'2026-01-02'}]}),/vente/);
 assert.throws(()=>validateDayInvoiceReference({...snapshot,settlementStates:[{operationId:'33333333-3333-4333-8333-333333333333',clientId}]}),/incomplètes/);
});

test('référence v6 : les preuves de règlement sont complètes, uniques et obligatoires',()=>{
 const id='33333333-3333-4333-8333-333333333333',global={operationId:id,clientId};
 const full={...snapshot,settlementStates:[global],settlementDays:[{...global,day:'2026-01-02'}],settlementProofs:[{operationId:id,hash:'a'.repeat(64)}]};
 assert.equal(validateDayInvoiceReference(full).settlementProofs[0].hash,'a'.repeat(64));
 assert.throws(()=>validateDayInvoiceReference({...full,settlementProofs:[]}),/incomplètes/);
 assert.throws(()=>validateDayInvoiceReference({...full,settlementProofs:[...full.settlementProofs,...full.settlementProofs]}),/invalide/);
 assert.throws(()=>validateDayInvoiceReference({...full,settlementProofs:[{operationId:id,hash:'not-a-hash'}]}),/invalide/);
 assert.throws(()=>validateDayInvoiceReference({...full,settlementProofs:undefined}),/invalide/);
});

test('marqueur de dette explicite lié à un règlement connu et à sa date',()=>{
 const id='33333333-3333-4333-8333-333333333333',global={operationId:id,clientId};
 const full={...snapshot,settlementStates:[global],settlementDays:[{...global,day:'2026-01-01'}],settlementProofs:[{operationId:id,hash:'a'.repeat(64)}],oldDebtMarkers:[{operationId:id,invoiceDay:'2026-01-01'}]};
 assert.deepEqual(validateDayInvoiceReference(full).oldDebtMarkers,full.oldDebtMarkers);
 assert.throws(()=>validateDayInvoiceReference({...full,oldDebtMarkers:[{operationId:id,invoiceDay:'2026-01-02'}]}),/Marqueur de dette/);
 assert.throws(()=>validateDayInvoiceReference({...full,oldDebtMarkers:[...full.oldDebtMarkers,...full.oldDebtMarkers]}),/Marqueur de dette/);
 assert.throws(()=>validateDayInvoiceReference({...full,oldDebtMarkers:[{operationId:id,invoiceDay:'2026-01-01',extra:true}]}),/Marqueur de dette/);
});
