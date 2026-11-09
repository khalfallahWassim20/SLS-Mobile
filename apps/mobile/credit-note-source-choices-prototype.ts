/** Modèle de liste préparatoire, sans modification des tables de ventes. */
import {canonicalJson,summarizePreInvoice} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import {readCreditSourcesPrototype} from './credit-note-sources-prototype';
import {readPrototypeCreditReferenceCache} from './credit-note-reference-cache-prototype';
import {readAllOfflineCreditPrototype} from './credit-note-offline-prototype';
import {tunisDay} from './journal';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
type Kind='sale'|'preinvoice';
type Choice={kind:Kind;invoiceId:string;version:number;clientId:string;clientName:string;invoiceDay:string;total:number;paid:number;oldDebtPaid:number;origin:'local'|'remote';blocked:'avoir-existant'|'rapprochement'|null};
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
function parse(payload:string):Record<string,any>{let value:unknown;try{value=JSON.parse(payload);}catch{throw Error('Facture locale illisible.');}if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Facture locale illisible.');return value as Record<string,any>;}
function describe(kind:Kind,id:string,version:number,clientId:string,source:Record<string,any>,origin:Choice['origin'],blocked:Choice['blocked']):Choice{
 let date:string,total:number,paid:number,oldDebtPaid:number,name:string;
 if(kind==='sale'){
  const d=new Date(source.createdAt);if(source.syncSaleId!==id||source.syncVersion!==version||source.clientId!==clientId||!Number.isFinite(d.getTime())||!Number.isSafeInteger(source.total)||source.total<0||!Number.isSafeInteger(source.paid)||source.paid<0)throw Error('Facture invalide.');
  date=tunisDay(d);total=source.total;paid=source.paid;oldDebtPaid=0;name=source.clientName;
 }else{
  const invoice=source.invoice;if(!invoice||invoice.id!==id||invoice.clientId!==clientId||source.version!==version||!Array.isArray(source.receipts))throw Error('Facture préétablie invalide.');
  const sum=summarizePreInvoice(invoice.amount,source.receipts);date=invoice.journalDate;total=invoice.amount;paid=sum.prePaid;oldDebtPaid=sum.oldDebtPaid;name=invoice.clientName;
 }
 if(!uuid(id)||!Number.isSafeInteger(version)||version<1||version>=1000000||typeof name!=='string'||!name.trim()||typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('Facture invalide.');
 return {kind,invoiceId:id,version,clientId,clientName:name,invoiceDay:date,total,paid,oldDebtPaid,origin,blocked};
}
/** Inclut les factures identifiées de ce téléphone même avant synchronisation.
 * Le cache d'autres appareils peut manquer hors ligne ; toute preuve périmée ou
 * incohérente reste une erreur, jamais une liste partielle silencieuse. */
export async function readCreditSourceChoices(tx:Tx,identity:DeviceIdentity,clientId:string,digest:(text:string)=>Promise<string>){
 const reference=await readPrototypeCreditReferenceCache(tx,identity);if(!reference)throw Error('Référence d’avoirs indisponible.');
 const client=reference.clients.find(c=>c.id===clientId);if(!client)throw Error('Client introuvable.');
 const cache=await readCreditSourcesPrototype(tx,identity,clientId,digest);
 const notes=await readAllOfflineCreditPrototype(tx,identity);
 const items=new Map<string,Choice>();
 const noteFor=(kind:Kind,id:string)=>notes.some(n=>n.note.kind===kind&&n.note.command.invoiceId===id);
 for(const item of cache?.items??[]){
  const source=item.source as Record<string,any>,note=noteFor(item.kind,item.invoiceId);
  const pending=await tx.getFirstAsync<{n:number}>(item.kind==='sale'?'SELECT EXISTS(SELECT 1 FROM sales_outbox WHERE sale_id=?) AS n':'SELECT EXISTS(SELECT 1 FROM journal_sync_outbox WHERE invoice_id=?) AS n',item.invoiceId);
  if(!pending)throw Error('File locale indisponible.');
  const local=await tx.getFirstAsync<{payload:string}>(item.kind==='sale'?`SELECT payload FROM sales WHERE json_valid(payload) AND json_extract(payload,'$.syncSaleId')=?`:'SELECT payload FROM journal_sync_state WHERE invoice_id=?',item.invoiceId);
  const divergent=local?canonicalJson(parse(local.payload))!==canonicalJson(source):false;
  items.set(`${item.kind}:${item.invoiceId}`,describe(item.kind,item.invoiceId,item.version,clientId,source,'remote',note?'avoir-existant':pending.n||divergent?'rapprochement':null));
 }
 const sales=await tx.getAllAsync<{payload:string}>('SELECT payload FROM sales WHERE client_id=? ORDER BY id',clientId);
 const invoices=await tx.getAllAsync<{id:string;payload:string}>('SELECT id,payload FROM tour_pre_invoices WHERE client_id=? ORDER BY rowid',clientId);
 const candidates:{kind:Kind;id:string;version:number;source:Record<string,any>}[]=[];
 for(const row of sales){const source=parse(row.payload),id=source.syncSaleId;if(!uuid(id))continue;candidates.push({kind:'sale',id,version:source.syncVersion,source});}
 for(const row of invoices){
  if(!uuid(row.id))continue;
  const state=await tx.getFirstAsync<{version:number;payload:string}>('SELECT version,payload FROM journal_sync_state WHERE invoice_id=?',row.id);if(!state)continue;
  const source=parse(state.payload),invoice=parse(row.payload),receipts=await tx.getAllAsync<{payload:string}>('SELECT payload FROM tour_journal_receipts WHERE pre_invoice_id=? ORDER BY rowid',row.id);
  if(source.version!==state.version||canonicalJson(source.invoice)!==canonicalJson(invoice)||canonicalJson(source.receipts)!==canonicalJson(receipts.map(r=>parse(r.payload))))throw Error('Historique local du journal incohérent.');
  candidates.push({kind:'preinvoice',id:row.id,version:state.version,source});
 }
 const seen=new Set<string>();
 for(const c of candidates){
  const key=`${c.kind}:${c.id}`;if(seen.has(key))throw Error('Facture locale dupliquée.');seen.add(key);
  const proof=await tx.getFirstAsync<{commercialId:string}>('SELECT commercial_id AS commercialId FROM identified_local_operations WHERE entity_id=? AND operation_kind=? LIMIT 1',c.id,c.kind==='sale'?'sale':'journal');
  if(!proof)continue;
  if(proof.commercialId!==identity.commercialId)throw Error('Facture liée à une autre identité.');
  const state=c.kind==='sale'?reference.saleStates.find(s=>s.saleId===c.id):reference.journalStates.find(j=>j.id===c.id);
  const proofForVersion=c.kind==='sale'?reference.eligibleSaleProofs.find(p=>p.saleId===c.id):reference.journalProofs.find(p=>p.id===c.id);
  const mismatch=!!state&&(state.clientId!==clientId||state.version>c.version||(state.version===c.version&&!!proofForVersion&&await digest(canonicalJson(c.source))!==proofForVersion.hash));
  const blocked=noteFor(c.kind,c.id)||state?.creditNote?'avoir-existant':mismatch?'rapprochement':null;
  items.set(key,describe(c.kind,c.id,c.version,clientId,c.source,'local',blocked));
 }
 return {clientId,active:client.active,remoteAvailable:!!cache,items:[...items.values()].sort((a,b)=>b.invoiceDay.localeCompare(a.invoiceDay)||a.invoiceId.localeCompare(b.invoiceId))};
}
