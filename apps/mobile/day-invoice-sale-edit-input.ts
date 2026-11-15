/** Conversion stricte des champs d'édition en quantités entières et centièmes de pourcentage. */
import type {SavedSale} from './storage';
import {unitPriceExcludingVat} from './reference';
type Line=SavedSale['lines'][number];
export type SaleEditDraftLine={line:Line;quantity:string;discount:string};
export function draftSaleLines(lines:Line[]):SaleEditDraftLine[]{return lines.map(line=>({line:{...line},quantity:String(line.quantity),discount:(line.discount/100).toFixed(2)}));}
export function parseSaleEditLines(draft:SaleEditDraftLine[]):Line[]{
 if(!Array.isArray(draft)||draft.length<1||draft.length>200)throw Error('La vente doit contenir entre 1 et 200 articles.');
 return draft.map(({line,quantity,discount})=>{
  if(!/^\d{1,7}$/.test(quantity)||Number(quantity)<1||Number(quantity)>1000000)throw Error('La quantité doit être un entier entre 1 et 1 000 000.');
  const match=/^(\d{1,3})(?:[,.](\d{1,2}))?$/.exec(discount.trim());
  if(!match)throw Error('La remise doit être un pourcentage entre 0 et 100, avec au plus deux décimales.');
  const rate=Number(match[1])*100+Number((match[2]??'').padEnd(2,'0'));if(rate>10000)throw Error('La remise ne peut pas dépasser 100 %.');
  return {...line,quantity:Number(quantity),discount:rate};
 });
}

/** Catalogue fourni par la référence v6 ; ne jamais proposer un code ambigu. */
export type SaleEditArticle={code:string;name:string;saleTtc:string;vatRate:number};
export function searchSaleEditArticles(articles:readonly SaleEditArticle[],draft:readonly SaleEditDraftLine[],query:string,limit=20):SaleEditArticle[]{
 const term=query.trim().toLocaleLowerCase('fr');if(!term)return [];
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Limite de recherche invalide.');
 const counts=new Map<string,number>();for(const item of articles)counts.set(item.code,(counts.get(item.code)??0)+1);
 const used=new Set(draft.map(item=>item.line.code));
 return articles.filter(item=>counts.get(item.code)===1&&!used.has(item.code)&&(`${item.code} ${item.name}`).toLocaleLowerCase('fr').includes(term)).slice(0,limit);
}
export function addSaleEditArticle(draft:readonly SaleEditDraftLine[],article:SaleEditArticle,articles:readonly SaleEditArticle[],original:readonly Line[]=[]):SaleEditDraftLine[]{
 if(draft.length>=200)throw Error('La vente ne peut pas contenir plus de 200 articles.');
 const matches=articles.filter(item=>item.code===article.code);
 if(matches.length!==1||matches[0].name!==article.name||matches[0].saleTtc!==article.saleTtc||matches[0].vatRate!==article.vatRate||draft.some(item=>item.line.code===article.code))throw Error('Article indisponible ou ambigu.');
 const old=original.filter(item=>item.code===article.code);if(old.length>1)throw Error('Article initial ambigu.');
 const line:Line=old.length?{...old[0],quantity:1,discount:0}:{code:article.code,name:article.name,quantity:1,unitPrice:unitPriceExcludingVat(article.saleTtc,article.vatRate),discount:0,vat:article.vatRate};
 return [...draft,{line,quantity:'1',discount:'0.00'}];
}
