import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isBelowPurchase,belowPurchaseLines,type PurchaseReference} from '../../../apps/api/src/purchase-price-alert.js';

const article:PurchaseReference={purchaseTtc:238000n,vatRate:1900};

test('vente sous le prix d’achat : repérée, jamais refusée',()=>{
 // 200 000 millimes HT = 238 000 millimes TTC : exactement le prix d’achat, pas de signalement.
 assert.equal(isBelowPurchase({unitPrice:200000,discount:0},article),false);
 assert.equal(isBelowPurchase({unitPrice:100000,discount:0},article),true);
 // Une remise peut à elle seule faire passer le prix net sous le prix d’achat.
 assert.equal(isBelowPurchase({unitPrice:200000,discount:2000},article),true);
 assert.equal(isBelowPurchase({unitPrice:200000,discount:0},{...article,purchaseTtc:230000n}),false);
});

test('vente sous le prix d’achat : tolérance d’un millime sur l’aller-retour TTC → HT → TTC',()=>{
 assert.equal(isBelowPurchase({unitPrice:199999,discount:0},article),false);
 assert.equal(isBelowPurchase({unitPrice:199990,discount:0},article),true);
});

test('vente sous le prix d’achat : données inconnues ou invalides jamais signalées',()=>{
 assert.equal(isBelowPurchase({unitPrice:1,discount:0},undefined),false);
 assert.equal(isBelowPurchase({unitPrice:1,discount:0},{...article,purchaseTtc:0n}),false);
 for(const line of [{unitPrice:'100000',discount:0},{unitPrice:-1,discount:0},{unitPrice:1.5,discount:0},{unitPrice:100000,discount:20000},{unitPrice:100000,discount:-1},{unitPrice:100000},{}])
  assert.equal(isBelowPurchase(line,article),false,JSON.stringify(line));
});

test('lignes d’une vente : positions des seules lignes sous le prix d’achat',()=>{
 const byCode=new Map<string,PurchaseReference>([['A',article],['B',{purchaseTtc:0n,vatRate:1900}]]);
 const lines=[{code:'A',unitPrice:100000,discount:0},{code:'B',unitPrice:100000,discount:0},{code:'A',unitPrice:200000,discount:0},{code:'INCONNU',unitPrice:1,discount:0},null,'texte',{unitPrice:1,discount:0},{code:'A',unitPrice:150000,discount:0}];
 assert.deepEqual(belowPurchaseLines(lines,byCode),[0,7]);
 assert.deepEqual(belowPurchaseLines(undefined,byCode),[]);
 assert.deepEqual(belowPurchaseLines({code:'A'},byCode),[]);
});
