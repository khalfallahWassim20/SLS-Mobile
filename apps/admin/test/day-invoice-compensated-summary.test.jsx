import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DayInvoiceCompensatedSummary,validateCompensatedSummary} from '../src/day-invoice-compensated-summary.jsx';

const client='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',commercial='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',day='2026-01-01';
const report={version:1,day,commercial:{id:commercial,name:'Commercial'},closure:{status:'open',version:0},totalBilled:750000,totalCollected:800000,refund:50000,credit:0,theoreticalNet:750000,rows:[{clientId:client,clientName:'<Client>',sector:'Nord',preInvoiceTotal:600000,salesTotal:150000,totalClient:750000,dayInvoicePaid:800000,oldDebtPaid:0,totalCollected:800000,refund:50000,credit:0,theoreticalNet:750000}]};
test('synthèse admin : facture globale, choix distinct et sécurité des mentions',()=>{
 const summary=validateCompensatedSummary(report,commercial,day),html=renderToStaticMarkup(<DayInvoiceCompensatedSummary summary={summary}/>);
 for(const s of ['600,000 DT','150,000 DT','750,000 DT','800,000 DT','50,000 DT','&lt;Client&gt;','ne prouvent ni une remise physique','ne valide pas la clôture'])assert.ok(html.includes(s),s);
 assert.doesNotMatch(html,/<Client>/);assert.doesNotMatch(html,/Exporter|Clôturer/);
});
test('synthèse admin refuse identité et montants incohérents',()=>{
 for(const bad of [{...report,version:2},{...report,commercial:{id:'autre',name:'x'}},{...report,theoreticalNet:800000},{...report,refund:0},{...report,rows:[{...report.rows[0],salesTotal:250000}]},{...report,rows:[report.rows[0],report.rows[0]]}])assert.throws(()=>validateCompensatedSummary(bad,commercial,day),/incohérent/);
 const negative={...report,totalBilled:0,totalCollected:0,theoreticalNet:-50000,rows:[{...report.rows[0],preInvoiceTotal:0,salesTotal:0,totalClient:0,dayInvoicePaid:0,totalCollected:0,theoreticalNet:-50000}]};
 assert.match(renderToStaticMarkup(<DayInvoiceCompensatedSummary summary={validateCompensatedSummary(negative,commercial,day)}/>),/-50,000 DT/);
});
