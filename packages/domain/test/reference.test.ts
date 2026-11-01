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
