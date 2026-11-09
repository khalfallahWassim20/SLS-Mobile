/** Lecture atomique préparatoire d'un export v5 ; non utilisée par l'écran v3. */
import {canonicalJson} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import type {SavedSale,TourPreInvoice,TourJournalReceipt} from './storage';
import {readPrototypeCreditReferenceCache} from './credit-note-reference-cache-prototype';
import {readAllOfflineCreditPrototype} from './credit-note-offline-prototype';
import {readPrototypeCreditBalance} from './credit-note-balance-storage-prototype';
import {buildJournal,tunisDay} from './journal';
import type {JournalExport} from './journal-export';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
function value<T>(raw:string):T {try {const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value as T;}catch{throw Error('Données locales illisibles : export refusé.');}}
/** L'appelant doit maintenir une transaction exclusive jusqu'à la fin ; les
 * références et mouvements changés pendant l'export ne sont pas mélangés.
 * Les annulations reçues d'un autre appareil sont signalées uniquement si
 * leur source complète et leur version correspondent aux preuves serveur. */
export async function readCreditJournalExportPrototype(tx:Tx,identity:DeviceIdentity,day:string,commercial:string,digest:(text:string)=>Promise<string>):Promise<JournalExport>{
 const parsed=new Date(`${day}T00:00:00.000Z`);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==day||typeof commercial!=='string'||!commercial.trim()||commercial.length>200)throw Error('Date ou commercial invalide.');
 const reference=await readPrototypeCreditReferenceCache(tx,identity);if(!reference)throw Error('Référence d’avoirs indisponible.');
 const credits=await readAllOfflineCreditPrototype(tx,identity);
 const saleRows=await tx.getAllAsync<{id:number;payload:string}>('SELECT id,payload FROM sales ORDER BY id DESC');
 const sales=saleRows.map(row=>({...value<Omit<SavedSale,'id'>>(row.payload),id:row.id}));
 const invoiceRows=await tx.getAllAsync<{payload:string}>('SELECT payload FROM tour_pre_invoices ORDER BY rowid');
 const invoices=invoiceRows.map(row=>value<TourPreInvoice>(row.payload));
 const receiptRows=await tx.getAllAsync<{payload:string}>('SELECT payload FROM tour_journal_receipts ORDER BY rowid');
 const receipts=receiptRows.map(row=>value<TourJournalReceipt>(row.payload));
 const sectors=new Map(reference.clients.map(c=>[c.id,c.sector]));
 const rows=buildJournal(day,invoices,sales,sectors),clientIds=new Set(rows.map(r=>r.clientId));
 for(const receipt of receipts.filter(r=>r.journalDate===day)){
  if(!rows.some(row=>row.clientId===receipt.clientId&&row.preInvoice?.id===receipt.preInvoiceId))throw Error('Règlement du journal sans facture : export refusé.');
  clientIds.add(receipt.clientId);
 }
 for(const {note} of credits){const src=note.source as {clientId?:string;invoice?:{clientId?:string}};const id=note.kind==='sale'?src.clientId:src.invoice?.clientId;if(!id)throw Error('Client de l’avoir indisponible.');if(tunisDay(new Date(note.command.recordedAt))===day)clientIds.add(id);}
 for(const id of clientIds){const balance=await readPrototypeCreditBalance(tx,identity,id,digest);if(balance.conflict)throw Error('Solde en conflit : export refusé.');}
 const remoteCancellations:NonNullable<JournalExport['remoteCancellations']>=[];
 for(const row of rows){
  for(const sale of row.sales){
   const state=reference.saleStates.find(s=>s.saleId===sale.syncSaleId);
   if(!state?.creditNote||credits.some(c=>c.note.kind==='sale'&&c.note.command.invoiceId===sale.syncSaleId))continue;
   const proof=reference.saleProofs.find(p=>p.saleId===sale.syncSaleId),pending=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM sales_outbox WHERE sale_id=?) AS n',sale.syncSaleId!);
   const {id:_id,...source}=sale;
   if(!proof||!pending||pending.n||state.clientId!==sale.clientId||proof.version!==sale.syncVersion||await digest(canonicalJson(source))!==proof.hash)throw Error('Annulation distante non confirmée : rapprochement nécessaire.');
   remoteCancellations.push({kind:'sale',invoiceId:state.saleId,day:tunisDay(new Date(state.creditNote.command.recordedAt)),source});
  }
  const invoice=row.preInvoice;if(!invoice)continue;
  const state=reference.journalStates.find(j=>j.id===invoice.id);
  if(!state?.creditNote||credits.some(c=>c.note.kind==='preinvoice'&&c.note.command.invoiceId===invoice.id))continue;
  const proof=reference.journalProofs.find(p=>p.id===invoice.id),pending=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM journal_sync_outbox WHERE invoice_id=?) AS n',invoice.id);
  const local=await tx.getFirstAsync<{version:number;payload:string}>('SELECT version,payload FROM journal_sync_state WHERE invoice_id=?',invoice.id);
  if(!proof||!pending||pending.n||!local||state.clientId!==invoice.clientId||proof.version!==local.version)throw Error('Annulation distante non confirmée : rapprochement nécessaire.');
  const source=value<{version:number;invoice:unknown;receipts:unknown}>(local.payload);
  if(source.version!==local.version||canonicalJson(source.invoice)!==canonicalJson(invoice)||canonicalJson(source.receipts)!==canonicalJson(receipts.filter(r=>r.preInvoiceId===invoice.id))||await digest(canonicalJson(source))!==proof.hash)throw Error('Annulation distante non confirmée : rapprochement nécessaire.');
  remoteCancellations.push({kind:'preinvoice',invoiceId:invoice.id,day:tunisDay(new Date(state.creditNote.recordedAt)),source});
 }
 return {day,commercial,rows,receipts,credits,remoteCancellations};
}
