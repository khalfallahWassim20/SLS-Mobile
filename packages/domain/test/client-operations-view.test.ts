import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chronologicalOperations } from '../../../apps/mobile/client-timeline.js';
import { canQuickSettleJournal } from '../../../apps/mobile/journal-quick-settlement.js';

test('chronologie fusionnée, dates exactes, égalités stables et dates invalides conservées', () => {
  const input = [
    {key:'facture',date:'2026-01-01T12:00:00Z'},
    {key:'règlement',date:'2026-01-01T13:00:00+01:00'},
    {key:'vente',date:'2026-01-02T10:00:00Z'},
    {key:'inconnue',date:'invalide'},
  ];
  assert.deepEqual(chronologicalOperations(input).map(x=>x.key),['vente','facture','règlement','inconnue']);
  assert.equal(input[0].key,'facture');
});

test('règlement rapide interdit si préétablie locale ou distante, données inconnues ou reçus du client', () => {
  const base={clientId:'a',referenceVersion:3,journalStates:[],preInvoices:[],receipts:[]};
  assert.equal(canQuickSettleJournal(base),true);
  assert.equal(canQuickSettleJournal({...base,referenceVersion:2}),false);
  assert.equal(canQuickSettleJournal({...base,journalStates:undefined}),false);
  assert.equal(canQuickSettleJournal({...base,journalStates:[{clientId:'a'}]}),false);
  assert.equal(canQuickSettleJournal({...base,preInvoices:[{clientId:'a'}]}),false);
  assert.equal(canQuickSettleJournal({...base,receipts:[{clientId:'a'}]}),false);
  assert.equal(canQuickSettleJournal({...base,journalStates:[{clientId:'b'}]}),true);
});

test('sections par jour tunisien : ordre chronologique conservé au changement de date et dates invalides visibles',async()=>{
  const {operationDay,operationDayLabel}=await import('../../../apps/mobile/client-timeline.js');
  const list=chronologicalOperations([
    {key:'vente',date:'2026-01-01T22:45:00Z'},
    {key:'paiement',date:'2026-01-01T23:30:00Z'},
    {key:'journal',date:'2026-01-02T02:00:00+01:00'},
    {key:'invalide',date:'inconnu'},
  ]);
  assert.deepEqual(list.map(p=>p.key),['journal','paiement','vente','invalide']);
  assert.deepEqual(list.map(p=>operationDay(p.date)),['2026-01-02','2026-01-02','2026-01-01',null]);
  assert.match(operationDayLabel(list[0].date),/2 janvier 2026/);
  assert.equal(operationDayLabel('inconnu'),'Date indisponible');
});

test('historique : crédit supplémentaire conservé, sans confondre avec remboursement ou ancien crédit',async()=>{
 const {revisionCreditAdded}=await import('../../../apps/mobile/client-timeline.js');
 const r=(oldTotal:number,oldPaid:number,newTotal:number,newPaid:number,refund:number)=>({previous:{total:oldTotal,paid:oldPaid},current:{total:newTotal,paid:newPaid},refund});
 assert.equal(revisionCreditAdded(r(250000,200000,150000,200000,0)),50000);
 assert.equal(revisionCreditAdded(r(150000,200000,120000,200000,0)),30000);
 assert.equal(revisionCreditAdded(r(150000,200000,160000,200000,0)),null);
 assert.equal(revisionCreditAdded(r(250000,200000,150000,150000,50000)),null);
 assert.equal(revisionCreditAdded(r(250000,200000,220000,200000,0)),null);
 assert.equal(revisionCreditAdded(r(250000,200000,150000,199999,0)),null);
 assert.equal(revisionCreditAdded(r(250000,200000,NaN,200000,0)),null);
});
