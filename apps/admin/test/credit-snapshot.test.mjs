import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {adaptCreditAdminSnapshot} from '../src/credit-snapshot-prototype.js';
import {prepareFullCreditNote} from '@sls/domain';
test('instantané administratif v5 : solde net et facture d’origine annulée',()=>{
 const id=randomUUID(),saleId=randomUUID(),sale={syncSaleId:saleId,syncVersion:1,clientId:id,clientName:'Client fictif',total:119000,paid:50000,remaining:69000};
 const creditNote=prepareFullCreditNote({actor:{id:'admin',role:'admin'},command:{operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:'2026-11-09T12:00:00.000Z',choice:'refund'},source:{invoiceId:saleId,version:1,total:119000,netPaid:50000,cancelled:false},daysOpen:true,previous:null}).event;
 const snapshot={version:5,balances:[{id,name:'Client fictif',openingBalance:'1000000',creditLimit:'0',balance:'1000000',active:false}],sales:[{saleId,version:1,sale,cancelled:true,creditNote}]};
 const adapted=adaptCreditAdminSnapshot(snapshot);
 assert.equal(adapted.balances[0].balance,'1000000');assert.equal(adapted.balances[0].active,false);assert.equal(adapted.sales[0].cancelled,true);assert.equal(adapted.sales[0].sale.total,119000);
 assert.throws(()=>adaptCreditAdminSnapshot({...snapshot,version:4}),/invalide/);
 assert.throws(()=>adaptCreditAdminSnapshot({...snapshot,sales:[{...snapshot.sales[0],creditNote:null}]}),/Vente/);
 assert.throws(()=>adaptCreditAdminSnapshot({...snapshot,sales:[{...snapshot.sales[0],creditNote:{...creditNote,refund:0}}]}),/Avoir/);
 assert.throws(()=>adaptCreditAdminSnapshot({...snapshot,sales:[{...snapshot.sales[0],sale:{...sale,total:120000}}]}),/Vente/);
 assert.throws(()=>adaptCreditAdminSnapshot({...snapshot,balances:[...snapshot.balances,...snapshot.balances]}),/Solde/);
});
