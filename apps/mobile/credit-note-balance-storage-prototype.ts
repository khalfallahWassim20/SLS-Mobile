/** Lecture préparatoire exclusivement : l'appelant doit fournir une transaction
 * SQLite exclusive. Ne pas brancher aux écrans avant le protocole complet v5. */
import {canonicalJson} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import {readPrototypeCreditReferenceCache} from './credit-note-reference-cache-prototype';
import {readAllOfflineCreditPrototype} from './credit-note-offline-prototype';
import {prototypeCreditBalance} from './credit-note-balance-prototype';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
function object(json:string):Record<string,any> {
 const parsed:unknown=JSON.parse(json);
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Données locales illisibles.');
 return parsed as Record<string,any>;
}
/** Toutes les sources, y compris le cache, sont lues dans la même transaction.
 * Une ligne orpheline ou un instantané divergent interrompt le calcul. */
export async function readPrototypeCreditBalance(tx:Tx,identity:DeviceIdentity,clientId:string) {
 const reference=await readPrototypeCreditReferenceCache(tx,identity);
 if(!reference)throw Error('Référence d’avoirs indisponible.');
 const notes=(await readAllOfflineCreditPrototype(tx,identity)).map(x=>x.note);
 const saleRows=await tx.getAllAsync<{id:number;clientId:string;payload:string}>('SELECT id,client_id AS clientId,payload FROM sales ORDER BY id');
 const sales=saleRows.map(row=>{const value=object(row.payload);if(value.clientId!==row.clientId||'id' in value)throw Error('Vente locale incohérente.');return {...value,id:row.id} as Parameters<typeof prototypeCreditBalance>[0]['sales'][number];});
 const paymentRows=await tx.getAllAsync<{clientId:string;payload:string}>('SELECT client_id AS clientId,payload FROM settlements ORDER BY id');
 const settlements=paymentRows.map(row=>{const value=object(row.payload);if(value.clientId!==row.clientId)throw Error('Règlement local incohérent.');return value as Parameters<typeof prototypeCreditBalance>[0]['settlements'][number];});
 const invoiceRows=await tx.getAllAsync<{id:string;clientId:string;journalDate:string;payload:string}>('SELECT id,client_id AS clientId,journal_date AS journalDate,payload FROM tour_pre_invoices ORDER BY rowid');
 const receiptRows=await tx.getAllAsync<{id:string;invoiceId:string;clientId:string;journalDate:string;payload:string}>('SELECT id,pre_invoice_id AS invoiceId,client_id AS clientId,journal_date AS journalDate,payload FROM tour_journal_receipts ORDER BY rowid');
 const states=await tx.getAllAsync<{invoiceId:string;version:number;payload:string}>('SELECT invoice_id AS invoiceId,version,payload FROM journal_sync_state ORDER BY rowid');
 const invoices=new Map(invoiceRows.map(r=>[r.id,r])),stateById=new Map(states.map(s=>[s.invoiceId,s])),receipts=new Map<string,Record<string,any>[]>();
 if(states.some(s=>!invoices.has(s.invoiceId)))throw Error('Version de journal sans facture.');
 for(const r of receiptRows){
  const invoice=invoices.get(r.invoiceId),value=object(r.payload);
  if(!invoice||invoice.clientId!==r.clientId||invoice.journalDate!==r.journalDate||value.id!==r.id||value.preInvoiceId!==r.invoiceId||value.clientId!==r.clientId||value.journalDate!==r.journalDate)throw Error('Règlement du journal incohérent.');
  const items=receipts.get(r.invoiceId)??[];items.push(value);receipts.set(r.invoiceId,items);
 }
 const journals=invoiceRows.map(row=>{
  const invoice=object(row.payload),state=stateById.get(row.id),items=receipts.get(row.id)??[];
  if(!state)throw Error('Facture locale sans version synchronisable.');
  const snapshot=object(state.payload);
  if(invoice.id!==row.id||invoice.clientId!==row.clientId||invoice.journalDate!==row.journalDate||snapshot.version!==state.version||canonicalJson(snapshot.invoice)!==canonicalJson(invoice)||canonicalJson(snapshot.receipts)!==canonicalJson(items))throw Error('Historique local du journal incohérent.');
  return {id:row.id,clientId:row.clientId,journalDate:row.journalDate,version:state.version,total:invoice.amount,receipts:items as Parameters<typeof prototypeCreditBalance>[0]['journals'][number]['receipts'],snapshot};
 });
 return prototypeCreditBalance({clientId,identity,reference,sales,journals,settlements,notes});
}
