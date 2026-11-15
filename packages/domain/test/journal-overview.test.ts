import {test} from 'node:test';
import assert from 'node:assert/strict';
import {journalVisualStatus} from '../../../apps/mobile/journal-overview.js';

test('journal visuel : factures et ancienne dette restent distinctes',()=>{
 assert.deepEqual(journalVisualStatus({amount:600000,receipts:[]},[{total:250000,paid:50000}]),{label:'Non traitée',tone:'coral',rest:800000});
 assert.deepEqual(journalVisualStatus({amount:600000,receipts:[{prePaid:0,oldDebtPaid:10000,creditFull:true}]},[{total:250000,paid:50000}]),{label:'Partiellement payée',tone:'amber',rest:800000});
 assert.deepEqual(journalVisualStatus({amount:600000,receipts:[{prePaid:600000,oldDebtPaid:10000,creditFull:false}]},[{total:250000,paid:250000}]),{label:'Soldée',tone:'mint',rest:0});
 assert.deepEqual(journalVisualStatus({amount:600000,receipts:[{prePaid:0,oldDebtPaid:10000,creditFull:true}]},[]),{label:'Impayée',tone:'coral',rest:600000});
});
test('journal visuel : lecture incohérente ne devient jamais « soldée »',()=>{
 assert.deepEqual(journalVisualStatus({amount:100,receipts:[{prePaid:101,oldDebtPaid:0,creditFull:false}]},[]),{label:'À vérifier',tone:'coral',rest:null});
 assert.deepEqual(journalVisualStatus(null,[{total:100,paid:-1}]),{label:'À vérifier',tone:'coral',rest:null});
 assert.deepEqual(journalVisualStatus(null,[{total:Number.MAX_SAFE_INTEGER,paid:0},{total:1,paid:0}]),{label:'À vérifier',tone:'coral',rest:null});
});
