import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prepareFullCreditNote} from '../src/credit-note-command.js';
import {reconcileSaleCredits} from '../src/sale-credit-reconciliation.js';
const id=randomUUID(),actor={id:randomUUID(),role:'commercial' as const},recordedAt='2026-11-08T10:00:00.000Z';
function example(choice:'refund'|'credit') {
 const command={operationId:randomUUID(),invoiceId:id,expectedVersion:2,recordedAt,choice};
 const source={invoiceId:id,version:2,total:600000,netPaid:200000,cancelled:false};
 const note=prepareFullCreditNote({actor,command,source,daysOpen:true,previous:null}).event;
 return {note,local:{syncSaleId:id,syncVersion:2,total:600000,paid:200000,creditNote:note},remote:{saleId:id,version:2,total:600000,paid:200000,creditNote:null},accepted:{saleId:id,version:3,total:0,paid:note.retainedCredit,creditNote:note}};
}
const calc=(balance:number,localSales:any[],serverSales:any[],localSettlements:any[]=[],serverSettlementIds:string[]=[])=>reconcileSaleCredits({serverBalance:balance,localSales,serverSales,localSettlements,serverSettlementIds});
test('vente : remboursement ou crédit en attente, puis accusé serveur sans double compte',()=>{
 const refund=example('refund'),credit=example('credit');
 // Solde initial 1000 + facture 600 - paiement 200 = 1400.
 assert.deepEqual(calc(1400000,[refund.local],[refund.remote]),{balance:1000000,conflict:false});
 assert.deepEqual(calc(1400000,[credit.local],[credit.remote]),{balance:800000,conflict:false});
 assert.deepEqual(calc(1000000,[refund.local],[refund.accepted]),{balance:1000000,conflict:false});
 assert.deepEqual(calc(800000,[credit.local],[credit.accepted]),{balance:800000,conflict:false});
});
test('vente encore locale et anciennes versions serveur',()=>{
 const x=example('credit');
 assert.deepEqual(calc(1000000,[x.local],[]),{balance:800000,conflict:false});
 assert.deepEqual(calc(1500000,[x.local],[{...x.remote,version:1,total:700000}]),{balance:800000,conflict:false});
 const settlementId=randomUUID();
 assert.deepEqual(calc(1000000,[x.local],[],[{syncOperationId:settlementId,amount:100000}],[settlementId]),{balance:800000,conflict:false});
 assert.deepEqual(calc(1000000,[x.local],[],[{syncOperationId:settlementId,amount:100000}],[]),{balance:700000,conflict:false});
});
test('conflits : vente modifiée ailleurs ou avoir différent',()=>{
 const x=example('credit'),y=example('refund');
 assert.equal(calc(1000000,[x.local],[{...x.remote,version:3}]).conflict,true);
 assert.equal(calc(1000000,[x.local],[{...x.remote,total:700000}]).conflict,true);
 assert.equal(calc(1000000,[{...x.local,creditNote:null}],[x.accepted]).conflict,true);
 assert.equal(calc(1000000,[x.local],[y.accepted]).conflict,true);
 const other=randomUUID(),remoteOther={...x.accepted,saleId:other,creditNote:{...x.note,command:{...x.note.command,invoiceId:other},source:{...x.note.source,invoiceId:other}}};
 assert.equal(calc(0,[x.local],[remoteOther]).conflict,true);
});
test('refuse données corrompues, doublons et débordement',()=>{
 const x=example('refund');
 assert.throws(()=>calc(0,[{...x.local,creditNote:{...x.note,refund:1}}],[]),/incohérent/);
 assert.throws(()=>calc(0,[x.local,x.local],[]),/dupliquée/);
 assert.throws(()=>calc(0,[x.local],[{...x.accepted,paid:10}]),/incohérent/);
 assert.throws(()=>calc(Number.MIN_SAFE_INTEGER,[example('credit').local],[]),/trop élevé/);
});
