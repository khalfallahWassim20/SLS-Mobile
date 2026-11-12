/** Révision commerciale v5 : préparation pure ; la transaction doit encore
 * vérifier la source, la journée, l'identité et le solde avant écriture. */
import {calculateInvoice,revisePayment,canonicalJson} from '@sls/domain';
import type {SavedSale} from './storage';
import type {CreditFormClient,CreditFormArticle} from './credit-sale-settlement-prototype';
import {unitPriceExcludingVat} from './reference';
import type {CreditWriteContext} from './credit-note-write-guard-prototype';
export type EditLine=SavedSale['lines'][number];
export function prepareCreditSaleEdit(client:CreditFormClient,context:CreditWriteContext,previous:SavedSale,lines:EditLine[],choice?:'refund'|'credit',articles:CreditFormArticle[]=[]){
 if(!client||!context||client.conflict||client.balance===null||!Number.isSafeInteger(client.balance)||client.balance!==context.expectedBalance||previous.clientId!==client.id)throw Error('Solde ou client modifié : actualisez.');
 if(!Number.isSafeInteger(previous.id)||previous.id<1||!previous.syncSaleId||!Number.isSafeInteger(previous.syncVersion)||previous.syncVersion!<1||previous.syncVersion!>=1000000||!Number.isSafeInteger(previous.paid)||previous.paid<0)throw Error('Vente identifiée indisponible.');
 if(choice!==undefined&&choice!=='refund'&&choice!=='credit')throw Error('Choix de remboursement invalide.');
 if(!Array.isArray(lines)||lines.length<1||lines.length>200)throw Error('Conservez au moins un article et au maximum 200.');
 const original=new Map(previous.lines.map(line=>[line.code,line]));
 if(original.size!==previous.lines.length)throw Error('Articles de la vente ambigus : rapprochement nécessaire.');
 const catalog=new Map<string,CreditFormArticle|null>();
 for(const a of articles)catalog.set(a.code,catalog.has(a.code)?null:a);
 const codes=new Set<string>();
 const clean=lines.map(line=>{
  const old=original.get(line.code);
  const article=catalog.get(line.code);
  const valid=old?line.name===old.name&&line.unitPrice===old.unitPrice&&line.vat===old.vat:!!article&&line.name===article.name&&line.unitPrice===unitPriceExcludingVat(article.saleTtc,article.vatRate)&&line.vat===article.vatRate;
  if(!valid||codes.has(line.code)||!Number.isSafeInteger(line.quantity)||line.quantity<1||line.quantity>1000000||!Number.isSafeInteger(line.discount)||line.discount<0||line.discount>10000)throw Error('Article, prix, quantité ou remise invalide.');
  codes.add(line.code);return {...line};
 });
 const total=calculateInvoice(clean.map(l=>({quantity:l.quantity,unitPrice:l.unitPrice,discountRate:l.discount,vatRate:l.vat}))).total;
 const result=revisePayment(total,previous.paid,choice);
 const newBalance=BigInt(client.balance)+BigInt(total)-BigInt(result.paid)-BigInt(previous.total)+BigInt(previous.paid);
 if(newBalance<BigInt(Number.MIN_SAFE_INTEGER)||newBalance>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Solde trop élevé.');
 return {updated:{...previous,lines:clean,total,paid:result.paid,remaining:result.remaining},refund:result.refund,credit:result.credit,balanceAfter:Number(newBalance)};
}
/** Revalide le contenu transmis à storage, sans faire confiance au formulaire. */
export function validateCreditSaleEdit(previous:SavedSale,updated:SavedSale,refund:number,articles:CreditFormArticle[]=[]){
 const client={id:previous.clientId,name:previous.clientName,sector:'',active:true,limit:0,serverBalance:0,balance:0,conflict:false,saleBlocked:false,blockReason:null,canSettle:false} as const;
 const result=prepareCreditSaleEdit(client,{identity:{commercialId:'',serverOrigin:''},expectedBalance:0},previous,updated.lines,refund?'refund':'credit',articles);
 const normalize=(value:SavedSale)=>canonicalJson({...value,lines:value.lines.map(l=>({name:l.name,code:l.code,quantity:l.quantity,unitPrice:l.unitPrice,discount:l.discount,vat:l.vat}))});
 if(!Number.isSafeInteger(refund)||refund<0||refund!==result.refund||normalize(updated)!==normalize(result.updated))throw Error('Révision de vente incohérente.');
}
