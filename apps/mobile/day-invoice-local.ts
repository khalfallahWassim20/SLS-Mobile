/** Lecture locale transactionnelle du périmètre de la facture du jour.
 * Cette fonction n'est pas encore utilisée par les écrans actifs. */
import {canonicalJson,summarizePreInvoice} from '@sls/domain';
import {tunisDay} from './journal';
import {readDayInvoicePayments,appendDayInvoicePayment,type DayInvoiceIdentity} from './day-invoice-queue';
import {validateDayInvoiceWrite,type DayInvoicePayment} from '../../packages/domain/src/day-invoice';
import type {SavedSale,TourPreInvoice,TourJournalReceipt,Settlement} from './storage';
import {readOldDebtOutbox} from './day-invoice-old-debt-queue';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {buildMergedDayInvoiceView} from './day-invoice-merged-view';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export async function readLocalDayInvoiceSource(tx:Tx,identity:DayInvoiceIdentity,clientId:string,day:string,digest?:(value:string)=>Promise<string>) {
 const invoices=await tx.getAllAsync<{id:string;payload:string}>('SELECT id,payload FROM tour_pre_invoices WHERE client_id=? AND journal_date=?',clientId,day);
 if(invoices.length>1)throw Error('Factures préétablies locales en conflit.');
 const rows=await tx.getAllAsync<{id:number;payload:string}>('SELECT id,payload FROM sales WHERE client_id=? ORDER BY id',clientId);
 const allSales=rows.map(row=>({...JSON.parse(row.payload),id:row.id}) as SavedSale);
 const daySales=allSales.filter(s=>tunisDay(new Date(s.createdAt))===day);
 const sales=daySales.map(s=>{
  if(s.clientId!==clientId || !s.syncSaleId || !Number.isSafeInteger(s.syncVersion) || !s.syncVersion)throw Error('Vente locale non synchronisable : rapprochement nécessaire.');
  return {id:s.syncSaleId,version:s.syncVersion,total:s.total,paid:s.paid};
 });
 // Un règlement global n'est pas attribué à une facture particulière : ne pas
 // le deviner, car cela pourrait permettre d'encaisser deux fois la journée.
 const settlementRows=await tx.getAllAsync<{payload:string}>('SELECT payload FROM settlements WHERE client_id=?',clientId);
 const settlements=settlementRows.map(row=>JSON.parse(row.payload) as Settlement);
 const candidates=settlements.filter(p=>tunisDay(new Date(p.createdAt))>=day);
 if(candidates.length){
  const reference=digest?await readDayInvoiceReferenceCache(tx,identity):null;
  const pending=reference&&digest?await readOldDebtOutbox(tx,identity):[];
  for(const settlement of candidates){
   const settlementDay=tunisDay(new Date(settlement.createdAt)),marker=reference?.oldDebtMarkers.find(m=>m.operationId===settlement.syncOperationId);
   if(marker){
    const state=reference?.settlementStates?.find(s=>s.operationId===settlement.syncOperationId),proof=reference?.settlementProofs.find(p=>p.operationId===settlement.syncOperationId);
    if(!digest||state?.clientId!==clientId||marker.invoiceDay!==settlementDay||!proof||await digest(canonicalJson(settlement))!==proof.hash)throw Error('Preuve de règlement local incohérente.');
    if(day<marker.invoiceDay)throw Error('Règlement global non attribué sur cette journée : rapprochement nécessaire.');
   }else {
    const entry=pending.find(e=>e.operationId===settlement.syncOperationId),event=entry?JSON.parse(entry.payload):null;
    if(entry){if(event.invoiceDay!==settlementDay||canonicalJson(event.event.settlement)!==canonicalJson(settlement))throw Error('Règlement local incohérent.');if(day<event.invoiceDay)throw Error('Règlement global non attribué sur cette journée : rapprochement nécessaire.');}
    else if(settlementDay===day)throw Error('Règlement global non attribué sur cette journée : rapprochement nécessaire.');
   }
  }
 }
 const dayPayments=await readDayInvoicePayments(tx,identity,clientId,day);
 let preInvoice:{id:string;version:number;total:number;paid:number;declared:boolean}|null=null;
 let receiptProof:{id:string;prePaid:number;oldDebtPaid:number;creditFull:boolean}[]=[];
 let oldDebtPaid=0;
 if(invoices[0]) {
  const p=JSON.parse(invoices[0].payload) as TourPreInvoice;
  if(p.id!==invoices[0].id || p.clientId!==clientId || p.journalDate!==day)throw Error('Facture locale incohérente.');
  const state=await tx.getFirstAsync<{version:number;payload:string}>('SELECT version,payload FROM journal_sync_state WHERE invoice_id=?',p.id);
  if(!state || !Number.isSafeInteger(state.version) || state.version<1)throw Error('Version de facture locale indisponible.');
  const snapshot=JSON.parse(state.payload);
  if(snapshot.version!==state.version || JSON.stringify(snapshot.invoice)!==JSON.stringify(p))throw Error('Version de facture locale incohérente.');
  const receiptRows=await tx.getAllAsync<{payload:string}>('SELECT payload FROM tour_journal_receipts WHERE pre_invoice_id=? ORDER BY rowid',p.id);
  const receipts=receiptRows.map(r=>JSON.parse(r.payload) as TourJournalReceipt);
  if(!Array.isArray(snapshot.receipts) || JSON.stringify(snapshot.receipts)!==JSON.stringify(receipts))throw Error('Historique de facture local incohérent.');
  const summary=summarizePreInvoice(p.amount,receipts);
  receiptProof=receipts.map(r=>({id:r.id,prePaid:r.prePaid,oldDebtPaid:r.oldDebtPaid,creditFull:r.creditFull}));oldDebtPaid=summary.oldDebtPaid;
  if(daySales.length && summary.oldDebtPaid>0)throw Error('Règlement historique non attribué : rapprochement nécessaire.');
  const declarations=dayPayments.filter(payment=>payment.preInvoice?.id===p.id&&payment.preInvoice.declare);
  if(declarations.length>1 || (declarations.length && summary.declared) || dayPayments.some(payment=>payment.preInvoice?.id===p.id && (payment.preInvoice.total!==p.amount || payment.preInvoice.version>state.version)))throw Error('Déclarations ou versions de facture locales en conflit.');
  preInvoice={id:p.id,version:state.version,total:p.amount,paid:summary.prePaid,declared:summary.declared||declarations.length===1};
 }
 if(preInvoice&&dayPayments.some(p=>p.preInvoice && p.preInvoice.id!==preInvoice!.id))throw Error('Paiement rattaché à une autre facture préétablie.');
 // Sans préétablie locale, la projection fusionnée devra prouver toute
 // référence à une facture distante avant d'accepter le paiement.
 return {clientId,day,preInvoice,sales,receiptProof,oldDebtPaid,dayPayments:dayPayments.map(p=>({id:p.operationId,amount:p.amount}))};
}

/** À appeler uniquement dans une transaction exclusive. La garde doit vérifier
 * l'identité liée, les clôtures et les protections métier avant toute écriture. */
export async function writeLocalDayInvoicePayment(tx:Tx,identity:DayInvoiceIdentity,payment:DayInvoicePayment,gate:(tx:Tx,identity:DayInvoiceIdentity,payment:DayInvoicePayment)=>Promise<void>) {
 return appendDayInvoicePayment(tx,payment,identity,async (locked,entry,owner)=>{
  await gate(locked,owner,entry);
  const previous=await locked.getFirstAsync<{payload:string}>('SELECT payload FROM day_invoice_payments WHERE operation_id=?',entry.operationId);
  if(previous && previous.payload===JSON.stringify(entry))return;
  const source=await readLocalDayInvoiceSource(locked,owner,entry.clientId,entry.day);
  validateDayInvoiceWrite(entry,source);
 });
}

/** Futur parcours d'écriture : même capture exclusive pour les contrôles,
 * l'instantané serveur connu, les sources et la création de la file. Il
 * nécessite une garde qui vérifie aussi les preuves des sources distantes.
 * Cette fonction n'est pas activée dans l'application. */
export async function writeReconciledDayInvoicePayment(tx:Tx,identity:DayInvoiceIdentity,payment:DayInvoicePayment,gate:(tx:Tx,identity:DayInvoiceIdentity,payment:DayInvoicePayment)=>Promise<void>,digest?:(value:string)=>Promise<string>) {
 return appendDayInvoicePayment(tx,payment,identity,async(locked,entry,owner)=>{
  await gate(locked,owner,entry);
  const previous=await locked.getFirstAsync<{payload:string}>('SELECT payload FROM day_invoice_payments WHERE operation_id=?',entry.operationId);
  if(previous&&previous.payload===JSON.stringify(entry))return;
  const reference=await readDayInvoiceReferenceCache(locked,owner);
  if(!reference)throw Error('Référence facture du jour indisponible : actualisation nécessaire.');
  const local=await readLocalDayInvoiceSource(locked,owner,entry.clientId,entry.day,digest);
  const localPayments=await readDayInvoicePayments(locked,owner,entry.clientId,entry.day);
  const merged=buildMergedDayInvoiceView(reference,local,localPayments);
  validateDayInvoiceWrite(entry,{...merged.source,dayPayments:merged.payments.map(p=>({id:p.operationId,amount:p.amount}))});
 });
}
