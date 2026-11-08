import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prototypeCreditCsv,prototypeCreditHtml} from '../src/credit-note-export-prototype.js';

test('export d’avoirs : date tunisienne, remboursements, crédits et dette ancienne séparés',()=>{
 const owner=randomUUID(),other=randomUUID(),client=randomUUID(),day='2026-11-08';
 const common={clientId:client,clientName:'=Client <fictif>',ownerId:owner,actor:{id:owner,role:'commercial'},invoiceDay:'2026-11-07',recordedAt:'2026-11-07T23:30:00.000Z',recordedDay:day,version:1};
 const sale={...common,operationId:randomUUID(),invoiceId:randomUUID(),kind:'sale',invoiceTotal:250000,netPaid:100000,oldDebtPaid:0,wasDeclared:true,refund:100000,retainedCredit:0,balanceDelta:-150000};
 const pre={...common,operationId:randomUUID(),invoiceId:randomUUID(),kind:'preinvoice',invoiceTotal:600000,netPaid:250000,oldDebtPaid:400000,wasDeclared:true,refund:0,retainedCredit:250000,balanceDelta:-600000};
 const excluded={...sale,operationId:randomUUID(),invoiceId:randomUUID(),ownerId:other};
 const csv=prototypeCreditCsv([sale,pre,excluded],day,owner,'Commercial fictif'),html=prototypeCreditHtml([sale,pre,excluded],day,owner,'<Direction>');
 assert.match(csv,/850,000/);assert.match(csv,/100,000/);assert.match(csv,/400,000/);assert.match(csv,/250,000/);assert.match(csv,/'=Client <fictif>/);assert.doesNotMatch(csv,new RegExp(excluded.invoiceId));
 assert.match(html,/&lt;Direction&gt;/);assert.match(html,/=Client &lt;fictif&gt;/);assert.match(html,/système principal/);
 assert.throws(()=>prototypeCreditCsv([sale,{...pre,refund:5}],day,owner,'Fictif'),/incohérents/);
 assert.throws(()=>prototypeCreditCsv([sale,sale],day,owner,'Fictif'),/invalide/);
 assert.throws(()=>prototypeCreditCsv([{...pre,recordedDay:'2026-11-07'}],day,owner,'Fictif'),/invalide/);
});
