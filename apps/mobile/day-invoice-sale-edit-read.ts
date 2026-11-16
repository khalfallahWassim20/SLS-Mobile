/** Sélection d'une vente locale pour l'éditeur v6, dans une transaction SQLite.
 * La capture métier vérifie la référence et les preuves avant toute édition. */
import type {DeviceIdentity} from './identified-device';
import {captureDayInvoiceSaleEdit} from './day-invoice-sale-edit';
import type {SavedSale} from './storage';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export async function readEditableDaySale(tx:Tx,identity:DeviceIdentity,clientId:string,day:string,saleId:number,digest:(text:string)=>Promise<string>):Promise<SavedSale>{
 if(!Number.isSafeInteger(saleId)||saleId<1)throw Error('Vente invalide.');
 const row=await tx.getFirstAsync<{clientId:string;payload:string}>('SELECT client_id AS clientId,payload FROM sales WHERE id=?',saleId);
 let value:SavedSale;try{value=JSON.parse(row?.payload??'');if(!value||!Array.isArray(value.lines))throw Error();}catch{throw Error('Vente locale illisible.');}
 if(!row||row.clientId!==clientId||value.clientId!==clientId)throw Error('Vente liée à un autre client.');
 const preview=await captureDayInvoiceSaleEdit(tx,identity,saleId,value.lines,digest);
 if(preview.previous.id!==saleId||preview.previous.clientId!==clientId||preview.day!==day)throw Error('Vente liée à une autre journée.');
 return preview.previous;
}
