/** Préparation/aperçu d'une modification d'une vente d'un autre téléphone.
 * Isolé et sans écriture : NE PAS synchroniser ni afficher comme opération
 * enregistrée. L'appelant doit fournir une transaction SQLite exclusive. */
import {calculateInvoice} from '@sls/domain';
import type {SavedSale} from './storage';
import type {CreditWriteContext} from './credit-note-write-guard-prototype';
import {assertCreditWritePrototype} from './credit-note-write-guard-prototype';
import {readCreditClientsPrototype} from './credit-client-view-prototype';
import {readCreditSourcesPrototype} from './credit-note-sources-prototype';
import {assertNoLocalCreditNote,assertNoRemoteCreditNote} from './credit-note-local-guard';
import {assertDeviceWritable} from './identified-device';
import {prepareCreditSaleEdit,type EditLine} from './credit-sale-edit-prototype';
import {tunisDay} from './journal';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
export type RemoteSaleKey={clientId:string;invoiceId:string;version:number;hash:string};
const saleKeys=['createdAt','clientId','clientName','syncSaleId','syncVersion','lines','total','paid','remaining','paymentMode','chequeNumber','chequeBank','chequeDue'].sort();
const lineKeys=['name','code','quantity','unitPrice','discount','vat'].sort();
const keyMatch=(value:object,keys:string[])=>JSON.stringify(Object.keys(value).sort())===JSON.stringify(keys);
function validateSource(value:Record<string,any>):SavedSale {
 if(!keyMatch(value,saleKeys)||!Array.isArray(value.lines)||value.lines.length<1||value.lines.length>200||!value.lines.every((l:any)=>l&&typeof l==='object'&&!Array.isArray(l)&&keyMatch(l,lineKeys)&&typeof l.name==='string'&&l.name.length>0&&l.name.length<=200&&typeof l.code==='string'&&l.code.length>0&&l.code.length<=100&&Number.isSafeInteger(l.quantity)&&l.quantity>0&&l.quantity<=1000000&&Number.isSafeInteger(l.unitPrice)&&l.unitPrice>=0&&Number.isSafeInteger(l.discount)&&l.discount>=0&&l.discount<=10000&&Number.isSafeInteger(l.vat)&&l.vat>=0&&l.vat<=10000))throw Error('Source de vente distante invalide.');
 const date=new Date(value.createdAt);
 if(typeof value.createdAt!=='string'||!Number.isFinite(date.getTime())||date.toISOString()!==value.createdAt||typeof value.clientName!=='string'||!value.clientName.trim()||value.clientName.length>200||!Number.isSafeInteger(value.total)||!Number.isSafeInteger(value.paid)||value.paid<0||!Number.isSafeInteger(value.remaining)||value.remaining!==Math.max(0,value.total-value.paid)||!['Espèces','Chèque','Virement','Crédit'].includes(value.paymentMode)||!['chequeNumber','chequeBank','chequeDue'].every(k=>typeof value[k]==='string'&&value[k].length<=100))throw Error('Source de vente distante invalide.');
 const calculated=calculateInvoice(value.lines.map((l:EditLine)=>({quantity:l.quantity,unitPrice:l.unitPrice,discountRate:l.discount,vatRate:l.vat})));
 if(calculated.total!==value.total)throw Error('Total de vente distante incohérent.');
 return {...value,id:1} as SavedSale; // identifiant fictif jamais persisté
}
/** Cache complet et preuve serveur sont revérifiés, y compris si les sources
 * ont été récupérées avant une synchronisation ou une annulation ultérieure. */
export async function captureRemoteSaleEditPrototype(tx:Tx,context:CreditWriteContext,key:RemoteSaleKey,recordedAt:string,digest:(text:string)=>Promise<string>){
 const time=new Date(recordedAt);
 if(typeof recordedAt!=='string'||!Number.isFinite(time.getTime())||time.toISOString()!==recordedAt||!key||typeof key.clientId!=='string'||typeof key.invoiceId!=='string'||!Number.isSafeInteger(key.version)||key.version<1||typeof key.hash!=='string'||!/^[0-9a-f]{64}$/.test(key.hash))throw Error('Identité ou date de modification invalide.');
 const snapshot=await readCreditClientsPrototype(tx,context.identity,digest),client=snapshot.clients.find(c=>c.id===key.clientId);
 if(!client||client.balance===null||client.conflict)throw Error('Client ou solde en conflit.');
 await assertCreditWritePrototype(tx,context,{kind:'edit',clientId:key.clientId},digest);
 const sources=await readCreditSourcesPrototype(tx,context.identity,key.clientId,digest),item=sources?.items.find(i=>i.kind==='sale'&&i.invoiceId===key.invoiceId);
 if(!item||item.version!==key.version||item.hash!==key.hash)throw Error('Source de vente périmée : actualisez les factures.');
 const local=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM sales WHERE json_valid(payload) AND json_extract(payload,'$.syncSaleId')=?) OR EXISTS(SELECT 1 FROM sales_outbox WHERE sale_id=?) AS n`,key.invoiceId,key.invoiceId);
 if(!local||local.n)throw Error('Vente locale ou modification en attente : rapprochement nécessaire.');
 await assertNoLocalCreditNote(tx,'sale',key.invoiceId);await assertNoRemoteCreditNote(tx,context.identity,'sale',key.invoiceId);
 const sale=validateSource(item.source);if(sale.clientId!==key.clientId||sale.syncSaleId!==key.invoiceId||sale.syncVersion!==key.version)throw Error('Source de vente incohérente.');
 if(time.getTime()<Date.parse(sale.createdAt))throw Error('Date de modification antérieure à la facture.');
 await assertDeviceWritable(tx,context.identity,[tunisDay(new Date(sale.createdAt)),tunisDay(time)]);
 return {key:{...key},client,articles:snapshot.articles,sale};
}
/** Calcul uniquement : aucun changement SQLite et aucune file créée. */
export async function previewRemoteSaleEditPrototype(tx:Tx,context:CreditWriteContext,key:RemoteSaleKey,recordedAt:string,lines:EditLine[],choice:'refund'|'credit'|undefined,digest:(text:string)=>Promise<string>){
 const capture=await captureRemoteSaleEditPrototype(tx,context,key,recordedAt,digest);
 const result=prepareCreditSaleEdit(capture.client,context,capture.sale,lines,choice,capture.articles);
 return {key:capture.key,previous:capture.sale,updated:result.updated,refund:result.refund,credit:result.credit,balanceBefore:context.expectedBalance,balanceAfter:result.balanceAfter};
}
