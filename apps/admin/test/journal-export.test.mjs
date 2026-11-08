import {test} from 'node:test';
import assert from 'node:assert/strict';
import {journalServerCsv,journalServerHtml} from '../src/journal-export.js';
const day={day:'2026-11-08',commercial:{name:'<Nom>'},closure:{status:'closed',version:1},clientCount:1,totalBilled:850000,journalCollected:650000,inheritedJournalTotal:20000,globalSettlementTotal:10000,totalCollected:680000,rows:[{clientName:'=2+3',sector:'Nord;"A"',preInvoiceTotal:600000,tourTotal:250000,totalClient:850000,preInvoicePaid:250000,oldDebtPaid:400000,tourPaid:0,totalCollected:650000,preInvoiceId:'p',declared:true}],inheritedJournalPayments:[{clientName:'Ancien',prePaid:10000,oldDebtPaid:10000}]};
test('export serveur : chiffres séparés, formules et caractères spéciaux',()=>{
 const csv=journalServerCsv(day,'2026-11-08T12:00:00Z');assert.ok(csv.startsWith('\uFEFF'));assert.match(csv,/850,000/);assert.match(csv,/600,000/);assert.match(csv,/250,000/);assert.match(csv,/680,000/);assert.match(csv,/"'=2\+3"/);assert.match(csv,/"Nord;""A"""/);assert.match(csv,/Ancien/);
 const html=journalServerHtml(day,'2026-11-08T12:00:00Z');assert.match(html,/&lt;Nom&gt;/);assert.doesNotMatch(html,/<Nom>/);assert.match(html,/850,000/);assert.match(html,/Clôturée/);assert.match(html,/non synchronisées/);
});
test('journal vide',()=>{const empty={...day,rows:[],inheritedJournalPayments:[],clientCount:0};assert.match(journalServerHtml(empty,'maintenant'),/Aucune donnée reçue/);assert.match(journalServerCsv(empty,'maintenant'),/Clients du journal/);});
