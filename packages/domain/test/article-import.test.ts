import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseArticleExport} from '../../../apps/api/src/article-import.js';
const input=(body:string)=>Buffer.from(`"","","Liste des Produits","","","",""\n"Code a barre","Libellé","P.AU Htva","","","",""\n${body}`);
test('import articles : marge sur achat TTC et arrondi aux millimes',()=>{
 const result=parseArticleExport(input('"X","Huile\n  fictive","46.310 dt","","","",""\n"123","Filtre","1,646.387 dt","","","",""\n"Commentaire","Commentaire","0.000 dt","","","",""\n"","USING FOR LABELS","0.000 dt","","","",""\n'));
 assert.equal(result.excluded,2);assert.equal(result.articles.length,2);
 assert.deepEqual(result.articles[0],{barcode:'X',name:'Huile fictive',purchaseHt:46310,purchaseTtc:55109,saleTtc:66131});
 assert.equal(result.articles[1].purchaseHt,1646387);assert.equal(result.articles[1].purchaseTtc,1959201);assert.equal(result.articles[1].saleTtc,2351041);
 assert.equal(parseArticleExport(input('"","Produit","0.004 dt","","","",""')).articles[0].saleTtc,6);
});
test('import articles : rejette les entrées ambiguës sans perte silencieuse',()=>{
 assert.throws(()=>parseArticleExport(Buffer.from('autre fichier')),/En-tête/);
 assert.throws(()=>parseArticleExport(input('"X","A","1.000 dt","","","",""\n"x","B","2.000 dt","","","",""')),/répété/);
 assert.throws(()=>parseArticleExport(input('"X","A","1.000 dt","donnée","","",""')),/supplémentaires/);
 assert.throws(()=>parseArticleExport(input('"X","A","0.000 dt","","","",""')),/limites/);
 assert.throws(()=>parseArticleExport(input('"X","A","1,234 dt","","","",""')),/Prix HT/);
});
