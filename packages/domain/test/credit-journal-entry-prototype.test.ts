import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prepareCreditPreInvoice,prepareCreditJournalReceipt} from '../../../apps/mobile/credit-journal-entry-prototype.js';
import type {TourJournalReceipt} from '../../../apps/mobile/storage.js';
const day='2026-11-10',time='2026-11-10T10:00:00.000Z',id=randomUUID(),invoiceId=randomUUID(),identity={commercialId:randomUUID(),serverOrigin:'https://sls.example.test'};
const client={id,name:'Fictif',sector:'Tunis',active:true,limit:0,serverBalance:1000000,balance:1000000,conflict:false,saleBlocked:false,blockReason:null,canSettle:true} as const;
const context={identity,expectedBalance:1000000},invoice={id:invoiceId,clientId:id,clientName:'Fictif',journalDate:day,createdAt:time,sector:'Tunis',amount:600000};
const input={prePaid:'250',oldDebtPaid:'400',creditFull:false,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:''};
test('préétablie v5 : montant TTC manuel, identité, date et statut',()=>{
 const value=prepareCreditPreInvoice(client,context,day,'600,000',time);assert.equal(value.amount,600000);assert.equal(value.clientId,id);assert.equal(value.sector,'Tunis');
 assert.throws(()=>prepareCreditPreInvoice({...client,active:false},context,day,'600',time),/désactivé/);
 assert.throws(()=>prepareCreditPreInvoice(client,context,day,'0',time),/positif/);
 assert.throws(()=>prepareCreditPreInvoice(client,context,'2026-11-11','600',time),/date/);
 assert.throws(()=>prepareCreditPreInvoice(client,{...context,expectedBalance:1},day,'600',time),/Solde/);
});
test('journal v5 : paiements facture et ancienne dette, crédit et plafonds',()=>{
 const first=prepareCreditJournalReceipt(client,context,invoice,[],input,time);assert.equal(first.value.prePaid,250000);assert.equal(first.value.oldDebtPaid,400000);assert.equal(first.value.oldDebtLimitAtStart,1000000);assert.equal(first.availableOldDebt,1000000);
 const previous=[{...first.value,id:randomUUID()}] satisfies TourJournalReceipt[];
 const next=prepareCreditJournalReceipt({...client,balance:950000},{...context,expectedBalance:950000},invoice,previous,{...input,prePaid:'50',oldDebtPaid:'100'},time);
 assert.equal(next.value.oldDebtLimitAtStart,1000000);assert.equal(next.availableOldDebt,600000);assert.equal(next.value.prePaid,50000);assert.equal(next.value.oldDebtPaid,100000);
 assert.throws(()=>prepareCreditJournalReceipt({...client,balance:950000},{...context,expectedBalance:950000},invoice,previous,{...input,prePaid:'0',oldDebtPaid:'600,001'},time),/dette/);
 assert.throws(()=>prepareCreditJournalReceipt({...client,balance:950000},{...context,expectedBalance:950000},invoice,previous,{...input,prePaid:'0',oldDebtPaid:'0',creditFull:true},time),/crédit|Crédit/);
 assert.throws(()=>prepareCreditJournalReceipt(client,context,invoice,[],{...input,prePaid:'0',oldDebtPaid:'0'},time),/paiement|crédit/);
 assert.equal(prepareCreditJournalReceipt(client,context,invoice,[],{...input,prePaid:'0',oldDebtPaid:'0',creditFull:true},time).value.creditFull,true);
 assert.throws(()=>prepareCreditJournalReceipt(client,context,invoice,[],{...input,creditFull:true},time),/crédit|Crédit/);
 assert.throws(()=>prepareCreditJournalReceipt(client,context,invoice,[],{...input,mode:'Chèque'},time),/chèque/);
 assert.throws(()=>prepareCreditJournalReceipt(client,context,invoice,[{...previous[0],clientId:randomUUID()}],input,time),/incohérent/);
});
