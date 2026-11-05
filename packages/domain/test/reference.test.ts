import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReference, formatMillimes } from '../../../apps/mobile/reference.js';
test('validate et retire les champs non autorisés de la référence', () => {
 const r = validateReference({ version: 1, clients: [{ id:'c',name:'Client',sector:'Sud', secret:'privé' }], articles:[{id:'a',code:'ART-1',barcode:'',name:'Huile',saleTtc:'70000',vatRate:1900,unitsPerCarton:3,purchaseTtc:'1000'}] });
 assert.equal(formatMillimes(r.articles[0].saleTtc), '70,000 DT');
 assert.equal('purchaseTtc' in r.articles[0], false);
 assert.equal('secret' in r.clients[0], false);
});
test('rejette un instantané incomplet ou des montants invalides', () => {
 assert.throws(() => validateReference({version:1,clients:[]}));
 assert.throws(() => validateReference({version:1,clients:[],articles:[{id:'a',code:'1',barcode:'',name:'X',saleTtc:'-1',vatRate:1900,unitsPerCarton:1}]}));
});

test('convertit le prix unitaire TTC en HT au millime sans flottants', async () => {
 const {unitPriceExcludingVat} = await import('../../../apps/mobile/reference.js');
 assert.equal(unitPriceExcludingVat('33000', 1900), 27731);
 assert.equal(unitPriceExcludingVat('70000', 1900), 58824);
 assert.equal(unitPriceExcludingVat('1', 0), 1);
 assert.throws(() => unitPriceExcludingVat('-1', 1900));
});
test('valide les soldes et préserve les anciens instantanés consultables', () => {
 const base = {id:'c',name:'Client',sector:'Sud'};
 assert.equal(validateReference({version:1,clients:[base],articles:[]}).clients[0].creditLimit, undefined);
 assert.equal(validateReference({version:1,clients:[{...base,openingBalance:'-50000',creditLimit:'2000000'}],articles:[]}).clients[0].openingBalance, '-50000');
 assert.throws(() => validateReference({version:1,clients:[{...base,openingBalance:'0',creditLimit:'-1'}],articles:[]}));
});

test('un instantané v2 exige un solde et des marqueurs cohérents', () => {
 const base={version:2,clients:[{id:'c',name:'X',sector:'Sud',openingBalance:'100',creditLimit:'0',serverBalance:'-20'}],articles:[],saleStates:[{saleId:'s',clientId:'c',version:1,total:'100',paid:'20'}],settlementStates:[{operationId:'p',clientId:'c'}]};
 assert.equal(validateReference(base).clients[0].serverBalance,'-20');
 assert.throws(()=>validateReference({...base,settlementStates:undefined}));
 assert.throws(()=>validateReference({...base,saleStates:[{...base.saleStates[0],clientId:'autre'}]}));
 assert.throws(()=>validateReference({...base,saleStates:[base.saleStates[0],base.saleStates[0]]}));
});


test('v3 contrôle et protège les marqueurs de factures et règlements du journal', () => {
 const base={version:3,clients:[{id:'c',name:'X',sector:'Sud',openingBalance:'1000000',creditLimit:'0',serverBalance:'1300000'}],articles:[],saleStates:[],settlementStates:[], journalStates:[{id:'f',clientId:'c',total:600000,receipts:[{id:'r',prePaid:0,oldDebtPaid:300000,creditFull:true,secret:'privé'}]}]};
 const v=validateReference(base);
 assert.equal(v.version,3); assert.equal('secret' in v.journalStates![0].receipts[0],false);
 assert.throws(()=>validateReference({...base,journalStates:undefined}));
 assert.throws(()=>validateReference({...base,journalStates:[base.journalStates[0],base.journalStates[0]]}));
 assert.throws(()=>validateReference({...base,journalStates:[{...base.journalStates[0],clientId:'autre'}]}));
 assert.throws(()=>validateReference({...base,journalStates:[{...base.journalStates[0],receipts:[{...base.journalStates[0].receipts[0],prePaid:1}]}]}));
 assert.throws(()=>validateReference({...base,journalStates:[{...base.journalStates[0],receipts:[base.journalStates[0].receipts[0],base.journalStates[0].receipts[0]]}]}));
});
