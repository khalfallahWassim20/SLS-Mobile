import {test} from 'node:test';
import assert from 'node:assert/strict';

const article = { saleTtc: '280255', vatRate: 1900 };

test('prix modifiable : prix catalogue = aucune modification, prix négocié converti en HT',async()=>{
 const {resolvePriceOverride}=await import('../../../apps/mobile/price-override.js');
 assert.deepEqual(resolvePriceOverride('280,255',article),{ok:true,unitPriceHt:235508,effectiveTtc:280255,changed:false,belowPurchase:false});
 assert.deepEqual(resolvePriceOverride('250',article),{ok:true,unitPriceHt:210084,effectiveTtc:250000,changed:true,belowPurchase:false});
 // Virgule et point sont acceptés ; TVA à 0 % : HT = TTC.
 assert.equal(resolvePriceOverride('250.5',article).ok,true);
 assert.deepEqual(resolvePriceOverride('100',{saleTtc:'120000',vatRate:0}),{ok:true,unitPriceHt:100000,effectiveTtc:100000,changed:true,belowPurchase:false});
});

test('prix modifiable : alerte sous le prix d’achat seulement si le prix d’achat est connu',async()=>{
 const {resolvePriceOverride}=await import('../../../apps/mobile/price-override.js');
 const withPurchase={...article,purchaseTtc:'238000'};
 assert.equal((resolvePriceOverride('200',withPurchase) as {belowPurchase:boolean}).belowPurchase,true);
 assert.equal((resolvePriceOverride('238',withPurchase) as {belowPurchase:boolean}).belowPurchase,false);
 assert.equal((resolvePriceOverride('238,001',withPurchase) as {belowPurchase:boolean}).belowPurchase,false);
 // Sans droit sur le prix d’achat : aucune information ne peut en être déduite.
 assert.equal((resolvePriceOverride('1',article) as {belowPurchase:boolean}).belowPurchase,false);
});

test('prix modifiable : saisies invalides refusées avec un message',async()=>{
 const {resolvePriceOverride}=await import('../../../apps/mobile/price-override.js');
 for(const bad of ['','abc','-5','1,2345','1 000,5','0','0,000','9007199254741']) {
  const result=resolvePriceOverride(bad,article);
  assert.equal(result.ok,false,`devrait refuser « ${bad} »`);
  assert.ok(typeof (result as {error:string}).error==='string' && (result as {error:string}).error.length>0);
 }
});

test('prix modifiable : l’écart entre le prix saisi et le TTC obtenu ne dépasse jamais un millime',async()=>{
 const {resolvePriceOverride}=await import('../../../apps/mobile/price-override.js');
 for(const vatRate of [0,700,1300,1900])
  for(let millimes=1;millimes<=3000;millimes+=7) {
   const text=`${Math.floor(millimes/1000)},${String(millimes%1000).padStart(3,'0')}`;
   const result=resolvePriceOverride(text,{saleTtc:'100000',vatRate});
   assert.equal(result.ok,true);
   if(result.ok)assert.ok(Math.abs(result.effectiveTtc-millimes)<=1,`TVA ${vatRate} : ${text} → ${result.effectiveTtc}`);
  }
});
