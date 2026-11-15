import {test} from 'node:test';
import assert from 'node:assert/strict';
import {draftSaleLines,parseSaleEditLines} from '../../../apps/mobile/day-invoice-sale-edit-input.js';
const line={code:'A',name:'Produit',quantity:2,unitPrice:1200,discount:125,vat:1900};
test('brouillon de révision : quantités et remises converties sans modifier le prix',()=>{
 const draft=draftSaleLines([line]);assert.equal(draft[0].discount,'1.25');assert.deepEqual(parseSaleEditLines(draft),[line]);
 draft[0].quantity='5';draft[0].discount='12,3';assert.deepEqual(parseSaleEditLines(draft),[{...line,quantity:5,discount:1230}]);assert.equal(line.quantity,2);
 draft[0].discount='100';assert.equal(parseSaleEditLines(draft)[0].discount,10000);
});
test('brouillon de révision : refuse quantité fractionnaire, remise invalide et vente vide',()=>{
 for(const quantity of ['0','-1','1.5','1000001','abc','']){const draft=draftSaleLines([line]);draft[0].quantity=quantity;assert.throws(()=>parseSaleEditLines(draft),/quantité/i);}
 for(const discount of ['-1','100,01','1,234','abc','']){const draft=draftSaleLines([line]);draft[0].discount=discount;assert.throws(()=>parseSaleEditLines(draft),/remise/i);}
 assert.throws(()=>parseSaleEditLines([]),/articles/);assert.throws(()=>parseSaleEditLines(draftSaleLines(Array(201).fill(line))),/articles/);
});

test('ajout depuis le catalogue : codes ambigus exclus et prix historique préservé',async()=>{
 const {searchSaleEditArticles,addSaleEditArticle}=await import('../../../apps/mobile/day-invoice-sale-edit-input.js');
 const article={code:'B',name:'Filtre',saleTtc:'11900',vatRate:1900};
 const others=[article,{code:'A',name:'Produit renommé',saleTtc:'9999',vatRate:1900},{code:'X',name:'Doublon',saleTtc:'1000',vatRate:0},{code:'X',name:'Doublon deux',saleTtc:'2000',vatRate:0}];
 let draft=draftSaleLines([line]);assert.deepEqual(searchSaleEditArticles(others,draft,'fil'),[article]);assert.deepEqual(searchSaleEditArticles(others,draft,'doublon'),[]);
 draft=addSaleEditArticle(draft,article,others,[line]);assert.deepEqual(draft[1].line,{code:'B',name:'Filtre',quantity:1,unitPrice:10000,discount:0,vat:1900});
 assert.throws(()=>addSaleEditArticle(draft,article,others,[line]),/indisponible/);
 draft=addSaleEditArticle([],others[1],others,[line]);assert.deepEqual(draft[0].line,{...line,quantity:1,discount:0});
 assert.throws(()=>addSaleEditArticle([],others[2],others,[]),/ambigu/);
});
