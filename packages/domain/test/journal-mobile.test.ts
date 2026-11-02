import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tunisDay, buildJournal, journalTotal } from '../../../apps/mobile/journal.js';
import type { SavedSale, TourPreInvoice } from '../../../apps/mobile/storage.js';
test('date Tunis et total des factures locales', () => {
 assert.equal(tunisDay(new Date('2026-05-05T23:30:00Z')), '2026-05-06');
 const id='12345678-1234-4234-8234-123456789abc';
 const pre:TourPreInvoice={id:'p',journalDate:'2026-05-06',clientId:id,clientName:'Client',sector:'Sud',amount:600000,createdAt:'2026-05-06T08:00:00Z'};
 const sale:SavedSale={id:1,createdAt:'2026-05-06T08:00:00Z',clientId:id,clientName:'Client',lines:[],total:250000,paid:0,remaining:250000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
 const rows=buildJournal('2026-05-06',[pre],[sale],new Map());
 assert.equal(rows.length,1); assert.equal(rows[0].total,850000); assert.equal(journalTotal(rows),850000);
 assert.equal(buildJournal('2026-05-07',[pre],[sale],new Map()).length,0);
 assert.throws(()=>buildJournal('2026-05-06',[pre,pre],[],new Map()));
});
