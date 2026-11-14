import {test} from 'node:test';
import assert from 'node:assert/strict';
import {indexSearch,searchIndexed,firstPage} from '../../../apps/mobile/paged-search.js';
test('catalogue important : recherche exhaustive et pages sans perte',()=>{
 const records=Array.from({length:3233},(_,i)=>({id:i,name:`Produit ${i}`,code:`P-${i}`,barcode:`999${i}`}));
 const index=indexSearch(records,x=>`${x.name} ${x.code} ${x.barcode}`);
 const all=searchIndexed(index,'');assert.equal(all.length,3233);assert.equal(firstPage(all,40).items.length,40);assert.equal(firstPage(all,40).hasMore,true);
 assert.equal(firstPage(all,3240).items.length,3233);assert.equal(firstPage(all,3240).hasMore,false);
 assert.equal(searchIndexed(index,'  P-3232 ')[0].id,3232);assert.equal(searchIndexed(index,'9993232')[0].id,3232);
 assert.equal(searchIndexed(index,'introuvable').length,0);assert.throws(()=>firstPage(all,0),/Taille/);
});
