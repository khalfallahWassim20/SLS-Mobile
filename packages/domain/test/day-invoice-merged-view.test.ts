import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateDayInvoiceReference} from '../../../apps/mobile/day-invoice-reference.js';
import {buildMergedDayInvoiceView} from '../../../apps/mobile/day-invoice-merged-view.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',invoiceId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',saleId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',sale2='dddddddd-dddd-4ddd-8ddd-dddddddddddd',day='2026-01-01';
const payment={operationId:'11111111-1111-4111-8111-111111111111',clientId,day,recordedAt:'2026-01-01T12:00:00.000Z',amount:200000,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:invoiceId,version:1,total:600000,declare:true},sales:[{id:saleId,version:1}]};
const snap={version:6,clients:[{id:clientId,name:'Client',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'650000'}],articles:[],saleStates:[{saleId,clientId,version:1,total:'250000',paid:'0'}],saleDays:[{saleId,clientId,day}],settlementStates:[],settlementDays:[],settlementProofs:[],journalStates:[{id:invoiceId,clientId,journalDate:day,total:600000,receipts:[],declaredByDayPayment:true}],journalProofs:[{id:invoiceId,version:1,hash:'a'.repeat(64)}],dayPayments:[payment]};
const local={clientId,day,preInvoice:{id:invoiceId,version:1,total:600000,paid:0,declared:true},sales:[{id:saleId,version:1,total:250000,paid:0}],receiptProof:[],oldDebtPaid:0,dayPayments:[{id:payment.operationId,amount:200000}]};
test('fusion des données locales et serveur : paiement déjà reçu compté une seule fois',()=>{const v=buildMergedDayInvoiceView(validateDayInvoiceReference(snap),local,[payment]);assert.equal(v.total,850000);assert.equal(v.remaining,650000);assert.equal(v.payments.length,1);assert.equal(v.payments[0].pending,false);assert.deepEqual(v.remoteOnlySaleIds,[]);});
test('fusion : facture et vente d’un autre téléphone visibles mais explicitement signalées',()=>{const ref=validateDayInvoiceReference({...snap,saleStates:[...snap.saleStates,{saleId:sale2,clientId,version:1,total:'100000',paid:'0'}],saleDays:[...snap.saleDays,{saleId:sale2,clientId,day}]});const v=buildMergedDayInvoiceView(ref,{...local,preInvoice:null,receiptProof:[],sales:[],dayPayments:[]},[]);assert.equal(v.total,950000);assert.equal(v.remaining,750000);assert.deepEqual(v.remoteOnlySaleIds.sort(),[saleId,sale2].sort());assert.equal(v.remoteOnlyPreInvoice,true);});
test('fusion : bloque preuve périmée, facture distincte et ancien règlement ambigu',()=>{const ref=validateDayInvoiceReference(snap);
 assert.throws(()=>buildMergedDayInvoiceView(ref,{...local,sales:[{...local.sales[0],version:2}]},[payment]),/incohérentes/);
 assert.throws(()=>buildMergedDayInvoiceView(ref,{...local,preInvoice:{...local.preInvoice,id:sale2}},[payment]),/incohérentes/);
 assert.throws(()=>buildMergedDayInvoiceView(ref,{...local,oldDebtPaid:1000},[payment]),/historique non attribué/);
 const global={operationId:'33333333-3333-4333-8333-333333333333',clientId};const withDebt=validateDayInvoiceReference({...snap,settlementStates:[global],settlementDays:[{...global,day}],settlementProofs:[{operationId:global.operationId,hash:'a'.repeat(64)}]});
 assert.throws(()=>buildMergedDayInvoiceView(withDebt,local,[payment]),/global non attribué/);
});

test('fusion : dette explicitement prouvée séparée du paiement du jour, mais pas rétroactivement',()=>{
 const id='33333333-3333-4333-8333-333333333333',global={operationId:id,clientId};
 const ref=validateDayInvoiceReference({...snap,settlementStates:[global],settlementDays:[{...global,day}],settlementProofs:[{operationId:id,hash:'a'.repeat(64)}],oldDebtMarkers:[{operationId:id,invoiceDay:day}]});
 assert.equal(buildMergedDayInvoiceView(ref,local,[payment]).remaining,650000);
 assert.throws(()=>buildMergedDayInvoiceView(ref,{...local,day:'2025-12-31'},[]),/global non attribué/);
});
