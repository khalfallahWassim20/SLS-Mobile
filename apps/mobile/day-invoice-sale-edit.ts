/** Révision locale v6 expérimentale, uniquement sans trop-perçu. Les fonctions
 * s'exécutent sous transaction SQLite exclusive et ne sont pas montées dans l'UI. */
import {canonicalJson,calculateInvoice} from '@sls/domain';
import {planDayInvoiceSaleExcess} from '../../packages/domain/src/day-invoice-excess-plan';
import {provePreCompensationSnapshot} from './day-invoice-compensation-snapshot';
import {assessDayInvoiceSaleRevision} from '../../packages/domain/src/day-invoice';
import {getDeviceIdentity,assertDeviceWritable,assertKnownDeviceEntity,recordDeviceOperation,type DeviceIdentity} from './identified-device';
import {assertLegacyMobileCreditSafe} from './credit-note-write-guard-prototype';
import {assertNoLocalCreditNote,assertNoRemoteCreditNote} from './credit-note-local-guard';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {readIdentifiedOutbox} from './identified-outbox';
import {readDayInvoiceOutbox} from './day-invoice-queue';
import {readOldDebtOutbox} from './day-invoice-old-debt-queue';
import {captureDayInvoiceForm} from './day-invoice-form';
import {readDayInvoiceClients} from './day-invoice-clients';
import {readLocalSaleCashLedger} from './credit-sale-refund-journal-prototype';
import {recordSaleEventTime} from './sale-event-time';
import {unitPriceExcludingVat} from './reference';
import {tunisDay} from './journal';
import type {SavedSale} from './storage';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type Line=SavedSale['lines'][number];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields=['createdAt','clientId','clientName','syncSaleId','syncVersion','lines','total','paid','remaining','paymentMode','chequeNumber','chequeBank','chequeDue'];
function lineKeys(line:unknown):line is Line{return !!line&&typeof line==='object'&&!Array.isArray(line)&&Object.keys(line).sort().join(',')==='code,discount,name,quantity,unitPrice,vat';}
/** Les autres clients peuvent avoir des opérations hors ligne. Ne jamais
 * ignorer une file non attribuable : dans le doute, la révision reste bloquée. */
async function ensureClientIdle(tx:Tx,identity:DeviceIdentity,clientId:string,day:string,saleId:string,version:number){
 const sources=await readIdentifiedOutbox(tx,identity),payments=await readDayInvoiceOutbox(tx,identity),debts=await readOldDebtOutbox(tx,identity);
 const ids=new Set<string>();
 const register=(id:string)=>{if(typeof id!=='string'||!uuid.test(id))throw Error('Identifiant d’opération en attente invalide.');const key=id.toLowerCase();if(ids.has(key))throw Error('Identifiant d’opération dupliqué entre files.');ids.add(key);};
 const different=(id:unknown)=>{if(typeof id!=='string'||!uuid.test(id))throw Error('Client d’une opération en attente inconnu : rapprochement nécessaire.');if(id.toLowerCase()===clientId.toLowerCase())throw Error('Opérations en attente pour ce client : synchronisez avant de modifier la facture.');};
 for(const entry of sources){register(entry.operationId);let event:any;try{event=JSON.parse(entry.payload);}catch{throw Error('Opération en attente illisible.');}
  if(!event||typeof event!=='object'||event.operationId!==entry.operationId)throw Error('Opération en attente incohérente.');
  if(entry.kind==='sale'){
   if(event.saleId!==entry.entityId||event.sale?.syncSaleId!==entry.entityId||event.sale?.syncVersion!==event.version||!Number.isSafeInteger(event.version))throw Error('Vente en attente incohérente.');
   const rows=await tx.getAllAsync<{clientId:string;payload:string}>('SELECT client_id AS clientId,payload FROM sales');
   const matches=rows.filter(r=>{try{return JSON.parse(r.payload).syncSaleId===entry.entityId;}catch{throw Error('Vente locale illisible.');}});
   if(matches.length!==1||matches[0].clientId!==event.sale.clientId||JSON.parse(matches[0].payload).clientId!==event.sale.clientId)throw Error('Client de vente en attente incohérent.');different(event.sale.clientId);
  } else if(entry.kind==='journal'){
   if(event.invoice?.id!==entry.entityId||!Number.isSafeInteger(event.version))throw Error('Journal en attente incohérent.');
   const rows=await tx.getAllAsync<{clientId:string;payload:string}>('SELECT client_id AS clientId,payload FROM tour_pre_invoices WHERE id=?',entry.entityId);
   if(rows.length!==1||rows[0].clientId!==event.invoice.clientId)throw Error('Client de facture en attente incohérent.');different(event.invoice.clientId);
  } else {
   if(entry.entityId!==entry.operationId||event.settlement?.syncOperationId!==entry.operationId||typeof event.settlement.clientId!=='string')throw Error('Règlement en attente incohérent.');
   const rows=await tx.getAllAsync<{payload:string}>('SELECT payload FROM settlements WHERE client_id=?',event.settlement.clientId);
   const matches=rows.filter(r=>{try{return JSON.parse(r.payload).syncOperationId===entry.operationId;}catch{throw Error('Règlement local illisible.');}});
   if(matches.length!==1||canonicalJson(JSON.parse(matches[0].payload))!==canonicalJson(event.settlement))throw Error('Client de règlement en attente incohérent.');different(event.settlement.clientId);
  }
 }
 for(const entry of payments){
  register(entry.operationId);const payment=JSON.parse(entry.payload);
  // Une révision sans excédent peut suivre un paiement hors ligne seulement
  // si sa photographie contient précisément la vente actuelle. Les autres
  // opérations du client restent bloquées et la compensation a sa garde dédiée.
  if(payment.clientId===clientId){if(payment.day!==day||!payment.sales.some((s:{id:string;version:number})=>s.id===saleId&&s.version===version))throw Error('Paiement en attente sur une autre version : synchronisez avant modification.');}
  else different(payment.clientId);
 }
 for(const entry of debts){register(entry.operationId);different(JSON.parse(entry.payload).event.settlement.clientId);}
}
/** L'aperçu est reproductible et fige la source, le solde et les lignes. */
export async function captureDayInvoiceSaleEdit(tx:Tx,identity:DeviceIdentity,saleId:number,lines:Line[],digest:(text:string)=>Promise<string>){
 if(!Number.isSafeInteger(saleId)||saleId<1)throw Error('Vente invalide.');
 const bound=await getDeviceIdentity(tx);if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur incohérent.');
 await assertLegacyMobileCreditSafe(tx,identity);
 const row=await tx.getFirstAsync<{payload:string;clientId:string}>('SELECT payload,client_id AS clientId FROM sales WHERE id=?',saleId);
 let raw:unknown;try{raw=JSON.parse(row?.payload??'');}catch{throw Error('Vente locale illisible.');}
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==fields.length||fields.some(k=>!(k in raw)))throw Error('Vente locale incohérente.');
 const previous={...(raw as Omit<SavedSale,'id'>),id:saleId};
 if(!row||row.clientId!==previous.clientId||!previous.syncSaleId||!uuid.test(previous.syncSaleId)||!Number.isSafeInteger(previous.syncVersion)||previous.syncVersion!<1||previous.syncVersion!>=1000000||!Number.isFinite(Date.parse(previous.createdAt))||!Array.isArray(previous.lines)||previous.lines.some(l=>!lineKeys(l)))throw Error('Vente locale incohérente.');
 const day=tunisDay(new Date(previous.createdAt));
 await ensureClientIdle(tx,identity,previous.clientId,day,previous.syncSaleId,previous.syncVersion!);
 await assertDeviceWritable(tx,identity,[day]);
 await assertNoLocalCreditNote(tx,'sale',previous.syncSaleId);await assertNoRemoteCreditNote(tx,identity,'sale',previous.syncSaleId);
 await assertKnownDeviceEntity(tx,identity,'sale',previous.syncSaleId,{clientId:previous.clientId,version:previous.syncVersion!,total:previous.total,paid:previous.paid,payload:row.payload,digest});
 await readLocalSaleCashLedger(tx,identity,[previous],day);
 const reference=await readDayInvoiceReferenceCache(tx,identity);if(!reference)throw Error('Référence facture du jour indisponible.');
 const pendingPayments=await readDayInvoiceOutbox(tx,identity);
 if(pendingPayments.some(p=>JSON.parse(p.payload).clientId===previous.clientId)){
  const proof=reference.saleProofs.find(p=>p.saleId===previous.syncSaleId);
  if(!proof||proof.version!==previous.syncVersion||proof.hash!==await digest(canonicalJson(raw)))throw Error('Preuve de vente préalable indisponible : synchronisez avant modification.');
 }
 if(reference.oldDebtMarkers.some(m=>reference.settlementStates?.some(s=>s.operationId===m.operationId&&s.clientId===previous.clientId)))throw Error('Règlement de dette enregistré : rapprochement requis avant modification.');
 const localDebt=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM day_invoice_old_debt_local WHERE client_id=?) AS n',previous.clientId);
 if(!localDebt||localDebt.n)throw Error('Règlement de dette enregistré : rapprochement requis avant modification.');
 const state=reference.saleStates?.find(s=>s.saleId===previous.syncSaleId);
 if(!state||state.clientId!==previous.clientId||state.version!==previous.syncVersion||state.total!==String(previous.total)||state.paid!==String(previous.paid))throw Error('Vente locale et serveur incohérentes.');
 const clients=await readDayInvoiceClients(tx,identity,digest),client=clients.clients.find(c=>c.id===previous.clientId);
 if(!client||client.conflict||client.balance===null)throw Error('Solde client indisponible.');
 const invoice=await captureDayInvoiceForm(tx,identity,previous.clientId,day,digest);
 const inInvoice=invoice.source.sales.find(s=>s.id===previous.syncSaleId);if(!inInvoice||inInvoice.version!==previous.syncVersion||inInvoice.total!==previous.total||inInvoice.paid!==previous.paid)throw Error('Facture du jour incohérente.');
 if(!Array.isArray(lines)||lines.length<1||lines.length>200||lines.some(l=>!lineKeys(l)))throw Error('Articles invalides.');
 const original=new Map(previous.lines.map(l=>[l.code,l]));if(original.size!==previous.lines.length)throw Error('Articles de vente ambigus.');
 const catalog=new Map<string,(typeof reference.articles)[number]|null>();for(const item of reference.articles)catalog.set(item.code,catalog.has(item.code)?null:item);
 const seen=new Set<string>();
 const clean=lines.map(line=>{const old=original.get(line.code),article=catalog.get(line.code);
  const valid=old?line.name===old.name&&line.unitPrice===old.unitPrice&&line.vat===old.vat:!!article&&line.name===article.name&&line.unitPrice===unitPriceExcludingVat(article.saleTtc,article.vatRate)&&line.vat===article.vatRate;
  if(!valid||seen.has(line.code)||!Number.isSafeInteger(line.quantity)||line.quantity<1||line.quantity>1000000||!Number.isSafeInteger(line.discount)||line.discount<0||line.discount>10000)throw Error('Article, prix, quantité ou remise invalide.');seen.add(line.code);return {...line};});
 const oldTotal=calculateInvoice(previous.lines.map(l=>({quantity:l.quantity,unitPrice:l.unitPrice,discountRate:l.discount,vatRate:l.vat}))).total;
 if(oldTotal!==previous.total||previous.remaining!==Math.max(0,previous.total-previous.paid))throw Error('Totaux de vente locale incohérents.');
 const total=calculateInvoice(clean.map(l=>({quantity:l.quantity,unitPrice:l.unitPrice,discountRate:l.discount,vatRate:l.vat}))).total;
 const source={...invoice.source,dayPayments:invoice.view.payments.map(p=>({id:p.operationId,amount:p.amount,declaration:p.mode==='Crédit'}))};
 const assessment=assessDayInvoiceSaleRevision(source,previous.syncSaleId,total);
 const balanceAfter=BigInt(client.balance)+BigInt(assessment.balanceDelta);if(balanceAfter>BigInt(Number.MAX_SAFE_INTEGER)||balanceAfter<BigInt(Number.MIN_SAFE_INTEGER))throw Error('Solde trop élevé.');
 // Simulation uniquement : aucune option ne valide ni ne comptabilise le choix.
 const excessPlan=assessment.requiresChoice?planDayInvoiceSaleExcess(source,previous.syncSaleId,total,client.balance):null;
 const fingerprint=canonicalJson({previous,invoice:invoice.fingerprint,balance:client.balance,lines:clean});
 // Ne pas proposer un choix impossible à reprendre : vérifier dès l'aperçu
 // que la photographie pourra être prouvée avec la référence conservée.
 if(assessment.requiresChoice){try{
  const before=await provePreCompensationSnapshot(tx,identity,JSON.parse(fingerprint),previous.clientId,day);
  if(before.total!==assessment.previousTotal||before.paid!==assessment.paid)throw Error();
 }catch{throw Error('Photographie de compensation non vérifiable : synchronisation et rapprochement nécessaires.');}}
 return {previous,lines:clean,day,assessment,balanceAfter:Number(balanceAfter),excessPlan,fingerprint};
}
export async function confirmDayInvoiceSaleEdit(tx:Tx,identity:DeviceIdentity,input:{saleId:number;lines:Line[];fingerprint:string;operationId:string;recordedAt:string},digest:(text:string)=>Promise<string>){
 if(!uuid.test(input.operationId)||typeof input.recordedAt!=='string'||!Number.isFinite(Date.parse(input.recordedAt))||new Date(input.recordedAt).toISOString()!==input.recordedAt)throw Error('Identifiant ou date de révision invalide.');
 const current=await captureDayInvoiceSaleEdit(tx,identity,input.saleId,input.lines,digest),previous=current.previous;
 if(input.fingerprint!==current.fingerprint)throw Error('La facture ou le solde a changé : vérifiez à nouveau.');
 if(current.assessment.requiresChoice)throw Error('Total inférieur au montant payé : remboursement ou crédit requis.');
 if(Date.parse(input.recordedAt)<=Date.parse(previous.createdAt))throw Error('Date de révision invalide.');
 const payments=await readDayInvoiceOutbox(tx,identity);
 if(payments.some(p=>{const payment=JSON.parse(p.payload);return payment.clientId===previous.clientId&&Date.parse(payment.recordedAt)>Date.parse(input.recordedAt);}))throw Error('Modification antérieure à un paiement en attente.');
 await assertDeviceWritable(tx,identity,[current.day,tunisDay(new Date(input.recordedAt))]);
 const taken=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM identified_local_operations WHERE operation_id=?) OR EXISTS(SELECT 1 FROM day_invoice_payments WHERE operation_id=?) OR EXISTS(SELECT 1 FROM day_invoice_old_debt_local WHERE operation_id=?) OR EXISTS(SELECT 1 FROM offline_credit_prototype WHERE operation_id=?) AS n`,input.operationId,input.operationId,input.operationId,input.operationId);
 if(!taken||taken.n)throw Error('Identifiant de révision déjà utilisé.');
 const last=await tx.getFirstAsync<{createdAt:string}>('SELECT created_at AS createdAt FROM sale_revisions WHERE sale_id=? ORDER BY id DESC LIMIT 1',input.saleId);
 if(last&&Date.parse(input.recordedAt)<=Date.parse(last.createdAt))throw Error('Date de révision non chronologique.');
 const updated={...previous,lines:current.lines,total:current.assessment.total-current.assessment.previousTotal+previous.total,remaining:Math.max(0,current.assessment.total-current.assessment.previousTotal+previous.total-previous.paid),syncVersion:previous.syncVersion!+1};
 const {id:_id,...payload}=updated;
 await tx.runAsync('UPDATE sales SET payload=? WHERE id=?',JSON.stringify(payload),input.saleId);
 await tx.runAsync('INSERT INTO sale_revisions(sale_id,created_at,previous_payload,new_payload,refund) VALUES(?,?,?,?,0)',input.saleId,input.recordedAt,JSON.stringify(previous),JSON.stringify(updated));
 const event={operationId:input.operationId,saleId:previous.syncSaleId,version:updated.syncVersion,sale:payload,refund:0};
 await tx.runAsync('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)',input.operationId,previous.syncSaleId!,updated.syncVersion,JSON.stringify(event));
 await recordSaleEventTime(tx,input.operationId,input.recordedAt);await recordDeviceOperation(tx,identity,input.operationId,'sale',previous.syncSaleId!,input.recordedAt);
 return {operationId:input.operationId,updated,assessment:current.assessment};
}
