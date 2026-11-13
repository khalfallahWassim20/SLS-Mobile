/** Vérification conservative préalable au passage d'un téléphone v4 vers v5.
 * Lecture uniquement dans la transaction exclusive de liaison. Les règlements
 * incluent une empreinte du contenu. Ces preuves ne démontrent pas
 * l’authenticité du serveur. */
import {canonicalJson} from '@sls/domain';
import type {validatePrototypeCreditReference} from './credit-note-reference-prototype';
type Tx={getAllAsync<T>(sql:string,...params:(string|number|null)[]):Promise<T[]>};
type Reference=ReturnType<typeof validatePrototypeCreditReference>;
function parse(payload:string):Record<string,unknown>{
 let value:unknown;try{value=JSON.parse(payload);}catch{throw Error('Opération locale illisible : rapprochement nécessaire.');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Opération locale invalide : rapprochement nécessaire.');
 return value as Record<string,unknown>;
}
export async function assertTransitionLocalHistory(tx:Tx,reference:Reference,digest:(text:string)=>Promise<string>):Promise<void>{
 const sales=await tx.getAllAsync<{clientId:string;payload:string}>('SELECT client_id AS clientId,payload FROM sales ORDER BY id');
 for(const row of sales){
  const sale=parse(row.payload),state=reference.saleStates.find(s=>s.saleId===sale.syncSaleId),proof=reference.eligibleSaleProofs.find(p=>p.saleId===sale.syncSaleId);
  if(sale.clientId!==row.clientId||!state||state.clientId!==row.clientId||state.creditNote||!proof||proof.version!==sale.syncVersion||state.version!==sale.syncVersion||String(sale.total)!==state.total||String(sale.paid)!==state.paid||await digest(canonicalJson(sale))!==proof.hash)throw Error('Vente locale sans preuve serveur identique : rapprochement nécessaire.');
 }
 const payments=await tx.getAllAsync<{clientId:string;payload:string}>('SELECT client_id AS clientId,payload FROM settlements ORDER BY id');
 for(const row of payments){const payment=parse(row.payload),state=reference.settlementStates?.find(s=>s.operationId===payment.syncOperationId);
  const proof=reference.settlementProofs?.find(p=>p.operationId===payment.syncOperationId);
  if(payment.clientId!==row.clientId||!state||state.clientId!==row.clientId||!proof||await digest(canonicalJson(payment))!==proof.hash)throw Error('Règlement local sans preuve serveur identique : rapprochement nécessaire.');
 }
 const journals=await tx.getAllAsync<{id:string;clientId:string;day:string;invoicePayload:string;version:number|null;payload:string|null}>(`SELECT p.id,p.client_id AS clientId,p.journal_date AS day,p.payload AS invoicePayload,s.version,s.payload FROM tour_pre_invoices p LEFT JOIN journal_sync_state s ON s.invoice_id=p.id ORDER BY p.rowid`);
 const receipts=await tx.getAllAsync<{id:string;invoiceId:string;clientId:string;day:string;payload:string}>('SELECT id,pre_invoice_id AS invoiceId,client_id AS clientId,journal_date AS day,payload FROM tour_journal_receipts ORDER BY rowid');
 const states=await tx.getAllAsync<{invoiceId:string}>('SELECT invoice_id AS invoiceId FROM journal_sync_state');
 if(states.some(s=>!journals.some(j=>j.id===s.invoiceId))||receipts.some(r=>!journals.some(j=>j.id===r.invoiceId)))throw Error('Journal local orphelin : rapprochement nécessaire.');
 for(const row of journals){
  const state=reference.journalStates.find(s=>s.id===row.id),proof=reference.journalProofs.find(p=>p.id===row.id);
  if(!row.payload||!state||state.clientId!==row.clientId||state.creditNote||!proof||proof.version!==row.version)throw Error('Préétablie locale sans preuve serveur identique : rapprochement nécessaire.');
  const snapshot=parse(row.payload),invoice=parse(row.invoicePayload),localReceipts=receipts.filter(r=>r.invoiceId===row.id);
  if(snapshot.version!==row.version||invoice.id!==row.id||invoice.clientId!==row.clientId||invoice.journalDate!==row.day||canonicalJson(invoice)!==canonicalJson(snapshot.invoice)||!Array.isArray(snapshot.receipts)||localReceipts.some(r=>{const value=parse(r.payload);return value.id!==r.id||value.preInvoiceId!==row.id||value.clientId!==row.clientId||value.journalDate!==row.day||r.clientId!==row.clientId||r.day!==row.day;})||canonicalJson(localReceipts.map(r=>parse(r.payload)))!==canonicalJson(snapshot.receipts)||await digest(canonicalJson(snapshot))!==proof.hash)throw Error('Préétablie locale sans preuve serveur identique : rapprochement nécessaire.');
 }
}
