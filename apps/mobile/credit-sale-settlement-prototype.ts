/** Préparation pure des formulaires commerciaux v5. Les écritures doivent
 * encore être protégées par la transaction SQLite de storage.ts. */
import {calculateInvoice,calculatePayment,parseDinars,balanceAfterSettlement,isSaleBlocked} from '@sls/domain';
import {unitPriceExcludingVat} from './reference';
import type {SavedSale,Settlement} from './storage';
import type {CreditWriteContext} from './credit-note-write-guard-prototype';
import type {readCreditClientsPrototype} from './credit-client-view-prototype';
type Clients=Awaited<ReturnType<typeof readCreditClientsPrototype>>;
export type CreditFormClient=Clients['clients'][number];
export type CreditFormArticle=Clients['articles'][number];
export type CreditCartLine={article:CreditFormArticle;quantity:number;discount:number};
export type CreditPayment={mode:'Espèces'|'Chèque'|'Virement'|'Crédit';paid:string;chequeNumber:string;chequeBank:string;chequeDue:string};
function check(client:CreditFormClient,context:CreditWriteContext){
 if(!client||!context||client.conflict||client.balance===null||!Number.isSafeInteger(client.balance)||client.balance!==context.expectedBalance||!Number.isSafeInteger(client.limit)||client.limit<0)throw Error('Solde ou contexte client invalide : actualisez.');
}
function cheque(payment:CreditPayment){
 if(!['Espèces','Chèque','Virement','Crédit'].includes(payment.mode))throw Error('Mode de paiement invalide.');
 const number=payment.chequeNumber.trim(),bank=payment.chequeBank.trim(),due=payment.chequeDue.trim();
 if([number,bank,due].some(v=>v.length>100))throw Error('Détails du chèque trop longs.');
 if(payment.mode==='Chèque'&&(!number||!bank||!due))throw Error('Renseignez le numéro, la banque et l’échéance du chèque.');
 return {chequeNumber:payment.mode==='Chèque'?number:'',chequeBank:payment.mode==='Chèque'?bank:'',chequeDue:payment.mode==='Chèque'?due:''};
}
function at(value:string){const date=new Date(value);if(!Number.isFinite(date.getTime())||date.toISOString()!==value)throw Error('Date d’opération invalide.');return value;}
export function prepareCreditSale(client:CreditFormClient,context:CreditWriteContext,cart:CreditCartLine[],payment:CreditPayment,createdAt:string):Omit<SavedSale,'id'> {
 check(client,context);
 if(!client.active||client.saleBlocked||isSaleBlocked(client.balance!,client.limit,false))throw Error('Vente bloquée pour ce client.');
 if(!Array.isArray(cart)||cart.length===0||cart.length>200)throw Error('Ajoutez entre 1 et 200 articles distincts.');
 const seen=new Set<string>();
 const lines=cart.map(({article,quantity,discount})=>{
  if(!article||typeof article.id!=='string'||seen.has(article.id)||typeof article.name!=='string'||!article.name.trim()||article.name.length>200||typeof article.code!=='string'||!article.code.trim()||article.code.length>100||!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000||!Number.isSafeInteger(discount)||discount<0||discount>10000)throw Error('Article, quantité ou remise invalide.');
  seen.add(article.id);return {name:article.name,code:article.code,quantity,unitPrice:unitPriceExcludingVat(article.saleTtc,article.vatRate),discount,vat:article.vatRate};
 });
 const totals=calculateInvoice(lines.map(l=>({quantity:l.quantity,unitPrice:l.unitPrice,discountRate:l.discount,vatRate:l.vat})));
 const paid=payment.mode==='Crédit'?0:parseDinars(payment.paid),summary=calculatePayment(totals.total,paid),details=cheque(payment);
 return {createdAt:at(createdAt),clientId:client.id,clientName:client.name,lines,total:totals.total,paid:summary.paid,remaining:summary.remaining,paymentMode:payment.mode,...details};
}
export function prepareCreditSettlement(client:CreditFormClient,context:CreditWriteContext,payment:CreditPayment,createdAt:string):Omit<Settlement,'id'> {
 check(client,context);if(payment.mode==='Crédit')throw Error('Choisissez espèces, chèque ou virement.');
 const amount=parseDinars(payment.paid);balanceAfterSettlement(client.balance!,amount);
 return {createdAt:at(createdAt),clientId:client.id,clientName:client.name,amount,mode:payment.mode,...cheque(payment)};
}
