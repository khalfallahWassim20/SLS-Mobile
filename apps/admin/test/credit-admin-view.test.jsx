import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CreditJournalView} from '../src/credit-journal-view.jsx';

test('vue admin préparatoire : avoir antérieur, remboursement et ancienne dette distincts',()=>{
 const owner=randomUUID();
 const note={kind:'preinvoice',operationId:randomUUID(),invoiceId:randomUUID(),invoiceDay:'2026-11-08',recordedAt:'2026-11-09T08:00:00.000Z',recordedDay:'2026-11-09',clientId:randomUUID(),clientName:'<Client fictif>',ownerId:owner,actor:{id:'admin',role:'admin'},version:2,invoiceTotal:600000,netPaid:250000,oldDebtPaid:400000,wasDeclared:true,refund:250000,retainedCredit:0,balanceDelta:-350000};
 const journal={day:'2026-11-09',commercial:{id:owner},rows:[],creditVersion:5,saleRefundEvents:[],saleRefundTotal:0,creditEvents:[note],creditNoteTotal:600000,creditRefundTotal:250000,creditRetainedTotal:0,totalBilled:0,totalCollected:0,billedAfterCredits:-600000,collectedAfterRefunds:-250000};
 const html=renderToStaticMarkup(React.createElement(CreditJournalView,{journal}));
 assert.match(html,/Avoirs créés ce jour/);assert.match(html,/-600,000 DT/);assert.match(html,/-250,000 DT/);
 assert.match(html,/400,000/);assert.match(html,/système principal/);assert.match(html,/&lt;Client fictif&gt;/);assert.doesNotMatch(html,/<Client fictif>/);
 assert.throws(()=>renderToStaticMarkup(React.createElement(CreditJournalView,{journal:{...journal,creditNoteTotal:1}})),/incohérents/);
 assert.equal(renderToStaticMarkup(React.createElement(CreditJournalView,{journal:{}})),'');
});


test('vue admin : détail des remboursements de vente et avertissement sans double déduction',()=>{
 const owner=randomUUID(),clientId=randomUUID(),saleRefundEvents=[{operationId:randomUUID(),saleId:randomUUID(),clientId,clientName:'<Client>',version:2,recordedAt:'2026-11-09T10:00:00.000Z',refund:38100}];
 const journal={day:'2026-11-09',commercial:{id:owner},rows:[{clientId,preInvoiceId:null,preInvoiceCancelled:false,cancelledSaleCount:0}],creditVersion:5,saleRefundEvents,saleRefundTotal:38100,creditEvents:[],creditNoteTotal:0,creditRefundTotal:0,creditRetainedTotal:0,totalBilled:11900,totalCollected:11900,billedAfterCredits:11900,collectedAfterRefunds:11900};
 const html=renderToStaticMarkup(React.createElement(CreditJournalView,{journal}));
 assert.match(html,/38,100 DT/);assert.match(html,/&lt;Client&gt;/);assert.match(html,/Ne les déduisez pas une seconde fois/);assert.match(html,/ne prouve pas le versement physique/);
});
