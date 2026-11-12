import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {validateAdminCreditSources,validateAdminCreditReview} from '../src/credit-admin-review-prototype.js';
import {CreditAdminReviewView} from '../src/credit-admin-review-view.jsx';

test('sélection et aperçu admin : dette ancienne conservée, incohérences refusées',()=>{
 const clientId=randomUUID(),id=randomUUID(),command={operationId:randomUUID(),invoiceId:id,expectedVersion:2,recordedAt:'2026-11-09T12:00:00.000Z',choice:'credit'},invoice={id,clientId,clientName:'<Fictif>',journalDate:'2026-11-08',amount:600000},receipt={prePaid:250000,oldDebtPaid:400000,creditFull:false};
 const data={version:5,clientId,active:true,truncated:false,items:[{kind:'preinvoice',invoiceId:id,version:2,hash:'a'.repeat(64),source:{version:2,invoice,receipts:[receipt]}}]};
 const [item]=validateAdminCreditSources(data,clientId);assert.equal(item.paid,250000);assert.equal(item.oldDebtPaid,400000);
 const review={version:5,clientId,clientName:'<Fictif>',kind:'preinvoice',command,sourceHash:item.hash,invoiceDay:item.date,invoiceTotal:600000,invoicePaid:250000,oldDebtPaid:400000,balanceBefore:950000,balanceAfter:350000,refund:0,retainedCredit:250000};
 assert.deepEqual(validateAdminCreditReview(review,clientId,item,command),review);
 assert.throws(()=>validateAdminCreditReview({...review,balanceAfter:600000},clientId,item,command),/incohérents/);
 assert.throws(()=>validateAdminCreditReview({...review,sourceHash:'b'.repeat(64)},clientId,item,command),/incohérent/);
 assert.throws(()=>validateAdminCreditSources({...data,truncated:true},clientId),/trop nombreuses/);
 assert.throws(()=>validateAdminCreditSources({...data,items:[data.items[0],data.items[0]]},clientId),/invalide/);
 const html=renderToStaticMarkup(React.createElement(CreditAdminReviewView,{clientId,request:async()=>data,onDone:()=>{},onCancel:()=>{}}));
 assert.match(html,/Préparer un avoir intégral/);assert.match(html,/opérations non synchronisées/i);
});
