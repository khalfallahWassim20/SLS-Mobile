import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { journalCsv, journalHtml } from '../../../apps/mobile/journal-export.js';

test('export local : montants, détail, échappement et protection tableur', () => {
 const data = { day:'2026-11-08', commercial:'<Commercial>', rows:[{clientId:'c',clientName:'=CLIENT',sector:'Nord; "A"',preInvoice:{id:'p',journalDate:'2026-11-08',clientId:'c',clientName:'=CLIENT',sector:'Nord',amount:600000,createdAt:'2026-11-08T10:00:00Z'},sales:[{id:1,createdAt:'2026-11-08T10:00:00Z',clientId:'c',clientName:'=CLIENT',lines:[],total:250000,paid:0,remaining:250000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}],total:850000}],receipts:[{id:'r',preInvoiceId:'p',clientId:'c',journalDate:'2026-11-08',createdAt:'2026-11-08T10:05:00Z',prePaid:200000,oldDebtPaid:300000,creditFull:false,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1000000}] };
 const csv=journalCsv(data); assert.ok(csv.startsWith('\uFEFF')); assert.match(csv,/'=CLIENT/); assert.match(csv,/850,000/); assert.match(csv,/200,000/); assert.match(csv,/300,000/); assert.match(csv,/Nord; ""A""/);
 const html=journalHtml(data); assert.match(html,/&lt;Commercial&gt;/); assert.match(html,/850,000/); assert.doesNotMatch(html,/<Commercial>/);
});
