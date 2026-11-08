/** Préparation expérimentale : table créée au démarrage, mais non utilisée par
 * les écrans ou l'envoi actuel. Chaque appel doit être effectué dans la même
 * transaction SQLite exclusive que les futures modifications de facture. */
import {calculatePreInvoiceCancellation,prepareFullCreditNote,canonicalJson,type CreditNoteCommand} from '@sls/domain';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {assertLocalTourWritable} from './tour-close-queue';
import {tunisDay} from './journal';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
type Kind='sale'|'preinvoice';
export type Note={kind:Kind;commercialId:string;serverOrigin:string;command:CreditNoteCommand;source:unknown;balanceDelta:number;refund:number;retainedCredit:number};
export const offlineCreditPrototypeSchema=`CREATE TABLE IF NOT EXISTS offline_credit_prototype (
 operation_id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('sale','preinvoice')),
 commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL, payload TEXT NOT NULL, pending INTEGER NOT NULL CHECK(pending IN (0,1)),
 UNIQUE(invoice_id,kind)
);`;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
async function bound(tx:Tx,identity:DeviceIdentity){
 const linked=await getDeviceIdentity(tx);
 if(!linked||linked.commercialId!==identity.commercialId||linked.serverOrigin!==identity.serverOrigin||!uuid(identity.commercialId))throw Error('Identité ou serveur du téléphone incohérent.');
}
/** L'état est lu depuis SQLite et non depuis l'écran. Ne s'applique qu'aux
 * factures dont une opération locale est liée à cette identité ; les anciennes
 * factures sans preuve restent refusées. Aucun solde actif n'est modifié. */
export async function prepareOfflineCreditPrototype(tx:Tx,identity:DeviceIdentity,kind:Kind,command:CreditNoteCommand):Promise<Note> {
 await bound(tx,identity);
 if(kind!=='sale'&&kind!=='preinvoice')throw Error('Type de facture invalide.');
 if(!command||!uuid(command.operationId)||!uuid(command.invoiceId)||!Number.isSafeInteger(command.expectedVersion)||command.expectedVersion<1||command.expectedVersion>=1000000||!['refund','credit',null].includes(command.choice)||typeof command.recordedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(command.recordedAt)||!Number.isFinite(Date.parse(command.recordedAt))||new Date(command.recordedAt).toISOString()!==command.recordedAt)throw Error('Demande invalide.');
 const proof=await tx.getFirstAsync<{commercialId:string}>(`SELECT commercial_id AS commercialId FROM identified_local_operations WHERE entity_id=? AND operation_kind=? LIMIT 1`,command.invoiceId,kind==='sale'?'sale':'journal');
 if(!proof||proof.commercialId!==identity.commercialId)throw Error('Facture sans identité locale confirmée : rapprochement nécessaire.');
 const taken=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM identified_local_operations WHERE operation_id=?) OR EXISTS(SELECT 1 FROM offline_credit_prototype WHERE operation_id=?) AS n`,command.operationId,command.operationId);
 if(!taken||taken.n)throw Error('Identifiant d’opération déjà utilisé.');
 const previous=await tx.getFirstAsync<{n:number}>(`SELECT count(*) AS n FROM offline_credit_prototype WHERE invoice_id=? AND kind=?`,command.invoiceId,kind);
 if(!previous||previous.n)throw Error('Facture déjà annulée.');
 let source:unknown,balanceDelta:number,refund:number,retainedCredit:number,invoiceDay:string;
 if(kind==='sale') {
  const row=await tx.getFirstAsync<{payload:string}>(`SELECT payload FROM sales WHERE json_valid(payload) AND json_extract(payload,'$.syncSaleId')=?`,command.invoiceId);
  if(!row)throw Error('Vente locale introuvable.');
  const sale=JSON.parse(row.payload);
  if(sale.syncSaleId!==command.invoiceId||sale.syncVersion!==command.expectedVersion||!Number.isFinite(Date.parse(sale.createdAt)))throw Error('Version ou date de vente incohérente.');
  invoiceDay=tunisDay(new Date(sale.createdAt));
  const lastChange=await tx.getFirstAsync<{at:string|null}>('SELECT MAX(recorded_at) AS at FROM identified_local_operations WHERE entity_id=? AND operation_kind=?',command.invoiceId,'sale');
  if(!lastChange?.at||!Number.isFinite(Date.parse(lastChange.at))||Date.parse(command.recordedAt)<Math.max(Date.parse(sale.createdAt),Date.parse(lastChange.at)))throw Error('Date de l’avoir antérieure à la dernière version.');
  const event=prepareFullCreditNote({actor:{id:identity.commercialId,role:'commercial'},command,source:{invoiceId:command.invoiceId,version:sale.syncVersion,total:sale.total,netPaid:sale.paid,cancelled:false},daysOpen:true,previous:null}).event;
  source=sale;balanceDelta=event.balanceDelta;refund=event.refund;retainedCredit=event.retainedCredit;
 } else {
  const row=await tx.getFirstAsync<{payload:string;version:number}>(`SELECT payload,version FROM journal_sync_state WHERE invoice_id=?`,command.invoiceId);
  const invoice=await tx.getFirstAsync<{payload:string}>(`SELECT payload FROM tour_pre_invoices WHERE id=?`,command.invoiceId);
  const receipts=await tx.getAllAsync<{payload:string}>(`SELECT payload FROM tour_journal_receipts WHERE pre_invoice_id=? ORDER BY rowid`,command.invoiceId);
  if(!row||!invoice||row.version!==command.expectedVersion)throw Error('Version de facture préétablie incohérente.');
  const snapshot=JSON.parse(row.payload),localInvoice=JSON.parse(invoice.payload),localReceipts=receipts.map(r=>JSON.parse(r.payload));
  if(snapshot.version!==row.version||snapshot.invoice?.id!==command.invoiceId||canonicalJson(snapshot.invoice)!==canonicalJson(localInvoice)||canonicalJson(snapshot.receipts)!==canonicalJson(localReceipts))throw Error('Historique du journal incohérent.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.invoice.journalDate))throw Error('Date du journal invalide.');
  invoiceDay=snapshot.invoice.journalDate;
  const times=[snapshot.invoice.createdAt,...localReceipts.map(r=>r.createdAt)].map(s=>Date.parse(s));
  if(times.some(t=>!Number.isFinite(t)||t>Date.parse(command.recordedAt)))throw Error('Date de l’avoir antérieure à la facture ou à un paiement.');
  const result=calculatePreInvoiceCancellation({balance:0,invoiceTotal:snapshot.invoice.amount,receipts:localReceipts,alreadyCancelled:false,choice:command.choice??undefined});
  source=snapshot;balanceDelta=result.balanceDelta;refund=result.refund;retainedCredit=result.retainedCredit;
 }
 for(const day of [...new Set([invoiceDay,tunisDay(new Date(command.recordedAt))])].sort())await assertLocalTourWritable(tx,identity.commercialId,day);
 const note:Note={kind,commercialId:identity.commercialId,serverOrigin:identity.serverOrigin,command:{...command},source,balanceDelta,refund,retainedCredit};
 await tx.runAsync('INSERT INTO offline_credit_prototype(operation_id,invoice_id,kind,commercial_id,server_origin,payload,pending) VALUES(?,?,?,?,?,?,1)',command.operationId,command.invoiceId,kind,identity.commercialId,identity.serverOrigin,JSON.stringify(note));
 return note;
}
/** Ne remet pas un avoir à l'envoyeur avant toutes les versions locales de sa
 * facture. Le rejet serveur ne supprime jamais l'entrée. */
export async function readReadyOfflineCreditPrototype(tx:Tx,identity:DeviceIdentity):Promise<Note[]> {
 await bound(tx,identity);
 const rows=await tx.getAllAsync<{payload:string;commercialId:string;serverOrigin:string;kind:Kind;invoiceId:string;operationId:string}>(`SELECT payload,commercial_id AS commercialId,server_origin AS serverOrigin,kind,invoice_id AS invoiceId,operation_id AS operationId FROM offline_credit_prototype WHERE pending=1 ORDER BY rowid`);
 const result:Note[]=[];
 for(const row of rows){
  const note:Note=JSON.parse(row.payload);
  if(row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin||note.commercialId!==row.commercialId||note.serverOrigin!==row.serverOrigin||note.kind!==row.kind||note.command?.invoiceId!==row.invoiceId||note.command.operationId!==row.operationId)throw Error('Avoir local incohérent.');
  const dependency=await tx.getFirstAsync<{n:number}>(row.kind==='sale'?'SELECT EXISTS(SELECT 1 FROM sales_outbox WHERE sale_id=?) AS n':'SELECT EXISTS(SELECT 1 FROM journal_sync_outbox WHERE invoice_id=?) AS n',row.invoiceId);
  if(!dependency)throw Error('File locale indisponible.');
  if(!dependency.n)result.push(note);
 }
 return result;
}
/** Ne retire que l'état « en attente » ; l'historique local est conservé. */
export async function acknowledgeOfflineCreditPrototype(tx:Tx,identity:DeviceIdentity,note:Note,response:unknown):Promise<void> {
 await bound(tx,identity);
 if(typeof response!=='object'||response===null||Array.isArray(response))throw Error('Accusé invalide.');
 const r=response as Record<string,unknown>;
 if((r.status!=='received'&&r.status!=='duplicate')||r.operationId!==note.command.operationId||note.commercialId!==identity.commercialId||note.serverOrigin!==identity.serverOrigin)throw Error('Accusé invalide.');
 const row=await tx.getFirstAsync<{payload:string;pending:number}>('SELECT payload,pending FROM offline_credit_prototype WHERE operation_id=?',note.command.operationId);
 if(!row||row.pending!==1||canonicalJson(JSON.parse(row.payload))!==canonicalJson(note))throw Error('Avoir modifié : accusé refusé.');
 await tx.runAsync('UPDATE offline_credit_prototype SET pending=0 WHERE operation_id=?',note.command.operationId);
}
