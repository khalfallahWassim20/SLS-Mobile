import {test} from 'node:test';import assert from 'node:assert/strict';
import {assessDayInvoiceSaleRevision} from '../src/day-invoice.js';
const source={preInvoice:{id:'pre',total:600000,paid:0,declared:true},sales:[{id:'sale',total:250000,paid:0}],dayPayments:[{id:'payment',amount:800000}]};
test('révision facture combinée : ne répartit pas les paiements entre les composantes',()=>{
 assert.deepEqual(assessDayInvoiceSaleRevision(source,'sale',300000),{previousTotal:850000,total:900000,paid:800000,balanceDelta:50000,remaining:100000,excess:0,requiresChoice:false});
 assert.deepEqual(assessDayInvoiceSaleRevision(source,'sale',150000),{previousTotal:850000,total:750000,paid:800000,balanceDelta:-100000,remaining:0,excess:50000,requiresChoice:true});
 assert.equal(assessDayInvoiceSaleRevision(source,'sale',200000).requiresChoice,false);
});
test('révision : montants invalides, sources dupliquées ou paiement antérieur impossible refusés',()=>{
 assert.throws(()=>assessDayInvoiceSaleRevision(source,'absente',1000),/indisponible/);
 assert.throws(()=>assessDayInvoiceSaleRevision(source,'sale',-1),/Montant/);
 assert.throws(()=>assessDayInvoiceSaleRevision({...source,sales:[...source.sales,...source.sales]},'sale',1000),/dupliquée/);
 assert.throws(()=>assessDayInvoiceSaleRevision({...source,dayPayments:[{id:'payment',amount:900000}]},'sale',1000),/supérieur/);
});
