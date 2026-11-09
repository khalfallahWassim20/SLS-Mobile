/** Modèle de liste préparatoire, sans modification des tables de ventes. */
import {canonicalJson,summarizePreInvoice} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import {readCreditSourcesPrototype} from './credit-note-sources-prototype';
import {readAllOfflineCreditPrototype} from './credit-note-offline-prototype';
import {tunisDay} from './journal';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
export async function readCreditSourceChoices(tx:Tx,identity:DeviceIdentity,clientId:string,digest:(text:string)=>Promise<string>){
 const cache=await readCreditSourcesPrototype(tx,identity,clientId,digest);if(!cache)throw Error('Factures indisponibles : actualisez les données.');
 const notes=await readAllOfflineCreditPrototype(tx,identity);
 const result=[];
 for(const item of cache.items){
  const source=item.source as Record<string,any>,note=notes.find(n=>n.note.kind===item.kind&&n.note.command.invoiceId===item.invoiceId);
  const pending=await tx.getFirstAsync<{n:number}>(item.kind==='sale'?'SELECT EXISTS(SELECT 1 FROM sales_outbox WHERE sale_id=?) AS n':'SELECT EXISTS(SELECT 1 FROM journal_sync_outbox WHERE invoice_id=?) AS n',item.invoiceId);
  if(!pending)throw Error('File locale indisponible.');
  const local=await tx.getFirstAsync<{payload:string}>(item.kind==='sale'?`SELECT payload FROM sales WHERE json_valid(payload) AND json_extract(payload,'$.syncSaleId')=?`:'SELECT payload FROM journal_sync_state WHERE invoice_id=?',item.invoiceId);
  let divergent=false;
  if(local){let snapshot:unknown;try{snapshot=JSON.parse(local.payload);}catch{throw Error('Facture locale illisible.');}divergent=canonicalJson(snapshot)!==canonicalJson(source);}
  let date:string,total:number,paid:number,oldDebtPaid:number,name:string;
  if(item.kind==='sale'){
   const d=new Date(source.createdAt);if(!Number.isFinite(d.getTime())||!Number.isSafeInteger(source.total)||source.total<0||!Number.isSafeInteger(source.paid)||source.paid<0)throw Error('Facture distante invalide.');
   date=tunisDay(d);total=source.total;paid=source.paid;oldDebtPaid=0;name=source.clientName;
  }else{
   const invoice=source.invoice;if(!invoice||!Array.isArray(source.receipts))throw Error('Facture distante invalide.');
   const sum=summarizePreInvoice(invoice.amount,source.receipts);date=invoice.journalDate;total=invoice.amount;paid=sum.prePaid;oldDebtPaid=sum.oldDebtPaid;name=invoice.clientName;
  }
  if(typeof name!=='string'||!name.trim()||typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('Facture distante invalide.');
  const blocked=note?'avoir-existant':pending.n||divergent?'rapprochement':null;
  result.push({kind:item.kind,invoiceId:item.invoiceId,version:item.version,clientId,clientName:name,invoiceDay:date,total,paid,oldDebtPaid,blocked});
 }
 return {clientId,active:cache.active,items:result.sort((a,b)=>b.invoiceDay.localeCompare(a.invoiceDay)||a.invoiceId.localeCompare(b.invoiceId))};
}
