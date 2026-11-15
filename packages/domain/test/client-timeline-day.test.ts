import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chronologicalOperations,operationsOnTunisDay} from '../../../apps/mobile/client-timeline.js';
test('chronologie du journal : filtrage par heure tunisienne, puis ordre des opérations',()=>{
 const revisions=[{id:1,createdAt:'2026-01-01T22:59:00.000Z'},{id:2,createdAt:'2026-01-01T23:05:00.000Z'}];
 const receipts=[{id:'a',createdAt:'2026-01-02T09:00:00.000Z'},{id:'b',createdAt:'2026-01-03T00:00:00.000Z'}];
 const selected=[...operationsOnTunisDay(revisions,'2026-01-02').map(v=>({key:`r${v.id}`,date:v.createdAt})),...operationsOnTunisDay(receipts,'2026-01-02').map(v=>({key:`p${v.id}`,date:v.createdAt}))];
 assert.deepEqual(chronologicalOperations(selected).map(v=>v.key),['pa','r2']);
 assert.deepEqual(operationsOnTunisDay([{createdAt:'date-invalide'}],'2026-01-02'),[]);
});
