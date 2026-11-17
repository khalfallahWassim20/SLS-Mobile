import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateCompensatedJournal} from '../../../apps/mobile/day-invoice-compensation-journal.js';
const commercialId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',clientId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',other='cccccccc-cccc-4ccc-8ccc-cccccccccccc',operationId='dddddddd-dddd-4ddd-8ddd-dddddddddddd',day='2026-01-01';
const expected={commercialId,clientId,operationId,day,refund:50000,credit:0};
const row={clientId,clientName:'Client',sector:'Nord',preInvoiceTotal:600000,salesTotal:150000,totalClient:750000,dayInvoicePaid:800000,oldDebtPaid:0,totalCollected:800000,refund:50000,credit:0,theoreticalNet:750000};
const second={clientId:other,clientName:'Autre',sector:'',preInvoiceTotal:0,salesTotal:100000,totalClient:100000,dayInvoicePaid:0,oldDebtPaid:0,totalCollected:0,refund:0,credit:0,theoreticalNet:0};
const journal={version:1,commercialId,clientId,operationId,day,totalBilled:850000,totalCollected:810000,refund:50000,credit:0,theoreticalNet:760000,rows:[row,second]};
test('journal serveur après remboursement : encaissement global peut contenir dette non ventilée',()=>{
 assert.equal(validateCompensatedJournal(journal,expected).theoreticalNet,760000);
 const differentDay={...journal,totalCollected:0,theoreticalNet:-50000,rows:[{...row,preInvoiceTotal:0,salesTotal:0,totalClient:0,dayInvoicePaid:0,totalCollected:0,theoreticalNet:-50000}],totalBilled:0};
 assert.equal(validateCompensatedJournal(differentDay,expected).rows[0].theoreticalNet,-50000);
});
test('journal serveur : refuse incohérences, doublons, identité et choix différents',()=>{
 for(const value of [{...journal,commercialId:other},{...journal,day:'2026-01-02'},{...journal,operationId:other},{...journal,theoreticalNet:1},{...journal,totalBilled:1},{...journal,refund:1},{...journal,extra:true},{...journal,rows:[row,row]},{...journal,rows:[{...row,refund:49999},second]},{...journal,rows:[{...row,theoreticalNet:1},second]},{...journal,rows:[{...row,totalClient:1},second]},{...journal,rows:[{...row,clientName:''},second]},{...journal,rows:[{...row,totalCollected:Number.MAX_SAFE_INTEGER+1},second]}])assert.throws(()=>validateCompensatedJournal(value,expected),/incohérent/);
 assert.throws(()=>validateCompensatedJournal(journal,{...expected,credit:1}),/incohérent/);
});
