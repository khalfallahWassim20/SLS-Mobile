/** Contrat écran v6 expérimental : un seul montant, jamais ventilé entre
 * préétablie et ventes. Capture et confirmation dans une transaction SQLite
 * exclusive distincte ; le reçu affiché doit encore correspondre au moment de
 * l'écriture. Ne raccorde pas les anciens écrans au protocole v6. */
import {canonicalJson} from '@sls/domain';
import {assertNoLocalDayCompensation} from './day-invoice-compensation-guard';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {readDayInvoicePayments,readDayInvoiceOutbox,type DayInvoiceIdentity} from './day-invoice-queue';
import {getDeviceIdentity} from './identified-device';
import {assertLocalDayPaymentProofs} from './day-invoice-payment-proof';
import {readLocalDayInvoiceSource,writeReconciledDayInvoicePayment} from './day-invoice-local';
import {buildMergedDayInvoiceView} from './day-invoice-merged-view';
import {verifiedPendingSaleRevisions} from './day-invoice-pending-sale-revision';
import {guardDayInvoiceWrite} from './day-invoice-guards';
import {validateDayInvoiceWrite,validateDayPayment,type DayInvoicePayment} from '../../packages/domain/src/day-invoice';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
/** Les sources distantes n'exposent pas encore leurs dates de révision : le
 * serveur effectue aussi ce contrôle avant écriture. */
async function assertLocalPaymentChronology(tx:Tx,clientId:string,recordedAt:string,source:{sales:{id:string}[];preInvoice:{id:string}|null}){
 const at=Date.parse(recordedAt);if(!Number.isFinite(at))throw Error('Date de paiement invalide.');
 const check=(value:unknown,message:string)=>{if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw Error('Date locale incohérente : rapprochement nécessaire.');if(Date.parse(value)>at)throw Error(message);};
 const ids=new Set(source.sales.map(s=>s.id));
 for(const row of await tx.getAllAsync<{id:number;payload:string}>('SELECT id,payload FROM sales WHERE client_id=?',clientId)){
  let sale:any;try{sale=JSON.parse(row.payload);}catch{throw Error('Vente locale illisible.');}
  if(!ids.has(sale?.syncSaleId))continue;
  check(sale.createdAt,'Paiement antérieur à une vente.');
  const revisions=await tx.getAllAsync<{createdAt:string}>('SELECT created_at AS createdAt FROM sale_revisions WHERE sale_id=?',row.id);
  for(const revision of revisions)check(revision.createdAt,'Paiement antérieur à une modification de vente.');
 }
 if(source.preInvoice){
  const row=await tx.getFirstAsync<{payload:string}>('SELECT payload FROM tour_pre_invoices WHERE id=? AND client_id=?',source.preInvoice.id,clientId);
  if(row){let invoice:any;try{invoice=JSON.parse(row.payload);}catch{throw Error('Préétablie locale illisible.');}check(invoice.createdAt,'Paiement antérieur à la préétablie.');
   for(const receipt of await tx.getAllAsync<{payload:string}>('SELECT payload FROM tour_journal_receipts WHERE pre_invoice_id=?',source.preInvoice.id)){let r:any;try{r=JSON.parse(receipt.payload);}catch{throw Error('Règlement local illisible.');}check(r.createdAt,'Paiement antérieur à un règlement de journal.');}
  }
 }
}
export async function captureDayInvoiceForm(tx:Tx,identity:DayInvoiceIdentity,clientId:string,day:string,digest?:(value:string)=>Promise<string>){
 await assertNoLocalDayCompensation(tx);
 const reference=await readDayInvoiceReferenceCache(tx,identity);
 if(!reference)throw Error('Référence facture du jour indisponible : actualisation nécessaire.');
 const local=await readLocalDayInvoiceSource(tx,identity,clientId,day,digest);
 const payments=await readDayInvoicePayments(tx,identity,clientId,day);
 assertLocalDayPaymentProofs(payments,await readDayInvoiceOutbox(tx,identity),reference);
 const verified=await verifiedPendingSaleRevisions(tx,identity,reference,local,reference.hasSaleProofs?digest:undefined);
 const view=buildMergedDayInvoiceView(reference,local,payments,verified);
 const source={...view.source,sales:[...view.source.sales].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)};
 const fingerprint=canonicalJson({source,payments:view.payments.map(({pending:_pending,collectionDay:_collectionDay,...p})=>p)});
 return {view:{clientId,day,preInvoiceTotal:view.preInvoiceTotal,salesTotal:view.salesTotal,total:view.total,paid:view.paid,remaining:view.remaining,declared:view.declared,payments:view.payments},fingerprint,source,remoteOnlyPreInvoice:view.remoteOnlyPreInvoice,remoteOnlySaleIds:view.remoteOnlySaleIds};
}
export async function confirmDayInvoiceForm(tx:Tx,identity:DayInvoiceIdentity,input:{clientId:string;day:string;fingerprint:string;operationId:string;recordedAt:string;amount:number;mode:DayInvoicePayment['mode'];chequeNumber:string;chequeBank:string;chequeDue:string},digest:(value:string)=>Promise<string>){
 // Une confirmation locale peut avoir été commise alors que l'interface a reçu
 // une erreur. Une reprise strictement identique doit être reconnue AVANT la
 // nouvelle capture, dont l'empreinte a forcément changé après le paiement.
 const existing=await tx.getFirstAsync<{payload:string;commercialId:string;serverOrigin:string;clientId:string;day:string}>(`SELECT payload,commercial_id AS commercialId,server_origin AS serverOrigin,client_id AS clientId,invoice_day AS day FROM day_invoice_payments WHERE operation_id=?`,input.operationId);
 if(existing){
  const bound=await getDeviceIdentity(tx);if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin||existing.commercialId!==identity.commercialId||existing.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur du téléphone incohérent.');
  let saved:DayInvoicePayment;try{saved=JSON.parse(existing.payload);validateDayPayment(saved);}catch{throw Error('Paiement local illisible.');}
  const fields=['operationId','clientId','day','recordedAt','amount','mode','chequeNumber','chequeBank','chequeDue'] as const;
  if(typeof input.fingerprint!=='string'||!input.fingerprint||existing.clientId!==saved.clientId||existing.day!==saved.day||fields.some(k=>saved[k]!==input[k]))throw Error('Identifiant de paiement déjà utilisé avec d’autres données.');
  const outbox=await readDayInvoiceOutbox(tx,identity),queued=outbox.find(e=>e.operationId===saved.operationId);
  if(!queued){const ref=await readDayInvoiceReferenceCache(tx,identity),remote=ref?.dayPayments.find(p=>p.operationId===saved.operationId);if(!remote||canonicalJson(remote)!==canonicalJson(saved))throw Error('Accusé de paiement indisponible : rapprochement nécessaire.');}
  return {status:'duplicate' as const,payment:saved};
 }
 const current=await captureDayInvoiceForm(tx,identity,input.clientId,input.day,digest);
 if(typeof input.fingerprint!=='string'||input.fingerprint!==current.fingerprint)throw Error('La facture du jour a changé : vérifiez à nouveau le montant avant de confirmer.');
 if(current.view.payments.some(p=>Date.parse(p.recordedAt)>Date.parse(input.recordedAt)))throw Error('Paiement antérieur à un règlement déjà enregistré.');
 await assertLocalPaymentChronology(tx,input.clientId,input.recordedAt,current.source);
 const pre=current.source.preInvoice;
 const payment:DayInvoicePayment={operationId:input.operationId,clientId:input.clientId,day:input.day,recordedAt:input.recordedAt,amount:input.amount,mode:input.mode,chequeNumber:input.chequeNumber,chequeBank:input.chequeBank,chequeDue:input.chequeDue,preInvoice:pre?{id:pre.id,version:pre.version,total:pre.total,declare:!pre.declared}:null,sales:current.source.sales.map(s=>({id:s.id,version:s.version}))};
 validateDayInvoiceWrite(payment,{...current.source,dayPayments:current.view.payments.map(p=>({id:p.operationId,amount:p.amount,declaration:p.mode==='Crédit'}))});
 const status=await writeReconciledDayInvoicePayment(tx,identity,payment,(locked,id,event)=>guardDayInvoiceWrite(locked,id,event,digest,true),digest);
 return {status,payment};
}
