/** Validation de la référence du règlement unifié. Non reliée au cache mobile actif. */
import {summarizePreInvoice} from '@sls/domain';
import {validateDayPayment,type DayInvoicePayment} from '../../packages/domain/src/day-invoice';
import {validateIdentifiedReference} from './identified-reference';
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const keys=['operationId','clientId','day','recordedAt','amount','mode','chequeNumber','chequeBank','chequeDue','preInvoice','sales'];
export function validateDayInvoiceReference(input:unknown) {
 if(!object(input)||input.version!==6||!Array.isArray(input.journalStates)||!Array.isArray(input.dayPayments)||!Array.isArray(input.saleDays)||!Array.isArray(input.settlementDays)||!Array.isArray(input.settlementProofs))throw Error('Référence facture du jour invalide.');
 const base=validateIdentifiedReference({...input,version:4});
 if(!base.journalStates || !base.saleStates || !base.settlementStates)throw Error('Marqueurs de référence manquants.');
 const saleStates=new Map(base.saleStates.map(s=>[s.saleId,s]));
 const saleDays=new Map<string,{saleId:string;clientId:string;day:string}>();
 for(const raw of input.saleDays){
  if(!object(raw)||Object.keys(raw).sort().join(',')!=='clientId,day,saleId'||typeof raw.saleId!=='string'||typeof raw.clientId!=='string'||typeof raw.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(raw.day))throw Error('Journée de vente invalide.');
  const date=new Date(`${raw.day}T00:00:00.000Z`),state=saleStates.get(raw.saleId);
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==raw.day||!state||state.clientId!==raw.clientId||saleDays.has(raw.saleId))throw Error('Journée de vente incohérente.');
  saleDays.set(raw.saleId,{saleId:raw.saleId,clientId:raw.clientId,day:raw.day});
 }
 if(saleDays.size!==saleStates.size)throw Error('Journées de vente incomplètes.');
 // Un cache plus ancien peut ne pas contenir ces preuves. Il reste lisible,
 // mais une vente ne peut être acquittée qu'après réception d'une preuve.
 if(input.saleProofs!==undefined&&!Array.isArray(input.saleProofs))throw Error('Preuves de vente invalides.');
 const saleProofs=new Map<string,{saleId:string;version:number;hash:string}>();
 for(const raw of (input.saleProofs??[]) as unknown[]){
  if(!object(raw)||Object.keys(raw).sort().join(',')!=='hash,saleId,version'||typeof raw.saleId!=='string'||typeof raw.version!=='number'||!Number.isSafeInteger(raw.version)||typeof raw.hash!=='string'||!/^[0-9a-f]{64}$/.test(raw.hash)||saleProofs.has(raw.saleId)||saleStates.get(raw.saleId)?.version!==raw.version)throw Error('Preuve de vente invalide.');
  saleProofs.set(raw.saleId,{saleId:raw.saleId,version:raw.version,hash:raw.hash});
 }
 if(input.saleProofs!==undefined&&saleProofs.size!==saleStates.size)throw Error('Preuves de vente incomplètes.');

 const settlements=new Map(base.settlementStates.map(s=>[s.operationId,s]));
 const settlementDays=new Map<string,{operationId:string;clientId:string;day:string}>();
 for(const raw of input.settlementDays){
  if(!object(raw)||Object.keys(raw).sort().join(',')!=='clientId,day,operationId'||typeof raw.operationId!=='string'||typeof raw.clientId!=='string'||typeof raw.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(raw.day))throw Error('Journée de règlement invalide.');
  const date=new Date(`${raw.day}T00:00:00.000Z`),state=settlements.get(raw.operationId);
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==raw.day||!state||state.clientId!==raw.clientId||settlementDays.has(raw.operationId))throw Error('Journée de règlement incohérente.');
  settlementDays.set(raw.operationId,{operationId:raw.operationId,clientId:raw.clientId,day:raw.day});
 }
 if(settlementDays.size!==settlements.size)throw Error('Journées de règlement incomplètes.');
 const settlementProofs=new Map<string,{operationId:string;hash:string}>();
 for(const raw of input.settlementProofs){
  if(!object(raw)||Object.keys(raw).sort().join(',')!=='hash,operationId'||typeof raw.operationId!=='string'||!settlements.has(raw.operationId)||settlementProofs.has(raw.operationId)||typeof raw.hash!=='string'||!/^[0-9a-f]{64}$/.test(raw.hash))throw Error('Preuve de règlement invalide.');
  settlementProofs.set(raw.operationId,{operationId:raw.operationId,hash:raw.hash});
 }
 if(settlementProofs.size!==settlements.size)throw Error('Preuves de règlement incomplètes.');
 // L'absence du champ dans un ancien instantané ne classe aucun règlement.
 // Elle ne peut jamais transformer un règlement historique ambigu en dette prouvée.
 if(input.oldDebtMarkers!==undefined&&!Array.isArray(input.oldDebtMarkers))throw Error('Marqueurs de dette invalides.');
 const oldDebtMarkers=new Map<string,{operationId:string;invoiceDay:string}>();
 for(const raw of (input.oldDebtMarkers??[]) as unknown[]){
  if(!object(raw)||Object.keys(raw).sort().join(',')!=='invoiceDay,operationId'||typeof raw.operationId!=='string'||typeof raw.invoiceDay!=='string'||settlementDays.get(raw.operationId)?.day!==raw.invoiceDay||oldDebtMarkers.has(raw.operationId))throw Error('Marqueur de dette incohérent.');
  oldDebtMarkers.set(raw.operationId,{operationId:raw.operationId,invoiceDay:raw.invoiceDay});
 }

 const flags=new Map<string,boolean>();
 for(const row of input.journalStates){if(!object(row)||typeof row.id!=='string'||typeof row.declaredByDayPayment!=='boolean'||flags.has(row.id))throw Error('Déclaration de facture invalide.');flags.set(row.id,row.declaredByDayPayment);}
 if(flags.size!==base.journalStates.length)throw Error('Déclarations de facture incomplètes.');
 const ids=new Set<string>(),declared=new Set<string>();
 const dayPayments=input.dayPayments.map(raw=>{
  if(!object(raw)||Object.keys(raw).length!==keys.length||keys.some(k=>!(k in raw)))throw Error('Paiement serveur invalide.');
  const p=raw as DayInvoicePayment;validateDayPayment(p);
  if(ids.has(p.operationId)||!base.clients.some(c=>c.id===p.clientId)||base.settlementStates!.some(s=>s.operationId===p.operationId))throw Error('Paiement serveur dupliqué ou mal rattaché.');ids.add(p.operationId);
  if(p.preInvoice){
   const invoice=base.journalStates!.find(j=>j.id===p.preInvoice!.id),proof=base.journalProofs.find(j=>j.id===p.preInvoice!.id);
   if(!invoice||!proof||invoice.clientId!==p.clientId||invoice.journalDate!==p.day||invoice.total!==p.preInvoice.total||proof.version<p.preInvoice.version)throw Error('Preuve de facture serveur invalide.');
   if(p.preInvoice.declare){if(declared.has(invoice.id)||summarizePreInvoice(invoice.total,invoice.receipts).declared)throw Error('Déclaration serveur en conflit.');declared.add(invoice.id);}
  }
  for(const sale of p.sales){const state=base.saleStates!.find(s=>s.saleId===sale.id);if(!state||saleDays.get(sale.id)?.day!==p.day||state.clientId!==p.clientId||state.version<sale.version)throw Error('Preuve de vente serveur invalide.');}
  return p;
 });
 for(const invoice of base.journalStates){if(flags.get(invoice.id)!==declared.has(invoice.id))throw Error('Déclaration de facture serveur incohérente.');}
 for(const payment of dayPayments)if(payment.preInvoice&&!payment.preInvoice.declare){const invoice=base.journalStates.find(j=>j.id===payment.preInvoice!.id)!;if(!declared.has(invoice.id)&&!summarizePreInvoice(invoice.total,invoice.receipts).declared)throw Error('Facture serveur non déclarée.');}
 return {...base,version:6 as const,saleDays:[...saleDays.values()],saleProofs:[...saleProofs.values()],hasSaleProofs:input.saleProofs!==undefined,settlementDays:[...settlementDays.values()],settlementProofs:[...settlementProofs.values()],oldDebtMarkers:[...oldDebtMarkers.values()],dayPayments,declaredByDayPayment:[...declared]};
}

import {reconcileClientBalance,reconcileJournalBalance} from '@sls/domain';
import {reconcileDayInvoicePayments} from '../../packages/domain/src/day-invoice';
import {hasJournalDayConflict} from './reference';
import type {SavedSale,Settlement,TourPreInvoice,TourJournalReceipt} from './storage';
type ParsedReference=ReturnType<typeof validateDayInvoiceReference>;
/** Calcul local préparatoire : aucun solde n'est accepté quand les preuves divergent. */
export function reconcileDayInvoiceClient(input:{
 reference:ParsedReference;clientId:string;localSales:readonly SavedSale[];localSettlements:readonly Settlement[];
 localInvoices:readonly (TourPreInvoice & {version:number;receipts:TourJournalReceipt[]})[];
 localDayPayments:readonly DayInvoicePayment[];verifiedPendingRevisions?:ReadonlySet<string>;
}) {
 const {reference,clientId}=input,client=reference.clients.find(c=>c.id===clientId);
 if(!client?.serverBalance || !reference.saleStates || !reference.settlementStates || !reference.journalStates)throw Error('Solde serveur indisponible.');
 const remoteSales=reference.saleStates.filter(s=>s.clientId===clientId),remoteJournals=reference.journalStates.filter(j=>j.clientId===clientId);
 const localInvoices=input.localInvoices.filter(p=>p.clientId===clientId);
 if(hasJournalDayConflict(clientId,localInvoices,remoteJournals))throw Error('Factures client/jour en conflit.');
 const sales=reconcileClientBalance({serverBalance:Number(client.serverBalance),localSales:input.localSales.filter(s=>s.clientId===clientId),serverSales:remoteSales.map(s=>({...s,total:Number(s.total),paid:Number(s.paid)})),localSettlements:input.localSettlements.filter(s=>s.clientId===clientId),serverSettlementIds:reference.settlementStates.filter(s=>s.clientId===clientId).map(s=>s.operationId)});
 const journal=reconcileJournalBalance(sales.balance,localInvoices.map(p=>({id:p.id,total:p.amount,receipts:p.receipts})),remoteJournals);
 if(sales.conflict||journal.conflict)throw Error('Solde ou facture en conflit.');
 const local=input.localDayPayments.filter(p=>p.clientId===clientId),remote=reference.dayPayments.filter(p=>p.clientId===clientId);
 const ids=new Set<string>();for(const payment of input.localDayPayments){validateDayPayment(payment);if(ids.has(payment.operationId))throw Error('Paiement local dupliqué.');ids.add(payment.operationId);const foreign=reference.dayPayments.find(p=>p.operationId===payment.operationId && p.clientId!==payment.clientId);if(foreign)throw Error('Paiement rattaché à un autre client.');}
 const remoteIds=new Set(remote.map(p=>p.operationId));
 for(const payment of local.filter(p=>!remoteIds.has(p.operationId))){
  if(payment.preInvoice){const invoice=localInvoices.find(p=>p.id===payment.preInvoice!.id),server=reference.journalProofs.find(p=>p.id===payment.preInvoice!.id);
   if(invoice && (invoice.version!==payment.preInvoice.version||invoice.amount!==payment.preInvoice.total))throw Error('Facture locale modifiée depuis le paiement.');
   if(server && server.version>payment.preInvoice.version)throw Error('Facture serveur modifiée depuis le paiement.');
   if(!invoice&&!server)throw Error('Facture du paiement indisponible.');
  }
  for(const proof of payment.sales){const mine=input.localSales.find(s=>s.clientId===clientId&&s.syncSaleId===proof.id),server=remoteSales.find(s=>s.saleId===proof.id);
   if(mine&&mine.syncVersion!==proof.version&&!(input.verifiedPendingRevisions?.has(proof.id)&&server?.version===proof.version&&mine.syncVersion===proof.version+1))throw Error('Vente locale modifiée depuis le paiement.');
   if(server&&server.version>proof.version)throw Error('Vente serveur modifiée depuis le paiement.');
   if(!mine&&(!server||server.version!==proof.version))throw Error('Vente du paiement indisponible.');
  }
 }
 let balance=journal.balance,pendingAmount=0;const days=new Set([...local,...remote].map(p=>p.day));
 for(const day of days){
  const serverInvoices=remoteJournals.filter(j=>j.journalDate===day).map(j=>({id:j.id,total:j.total,declared:summarizePreInvoice(j.total,j.receipts).declared||reference.declaredByDayPayment.includes(j.id)}));
  // Une préétablie créée hors ligne n'existe pas encore dans l'instantané serveur.
  for(const invoice of localInvoices.filter(p=>p.journalDate===day&&!serverInvoices.some(j=>j.id===p.id))){serverInvoices.push({id:invoice.id,total:invoice.amount,declared:summarizePreInvoice(invoice.amount,invoice.receipts).declared});}
  const result=reconcileDayInvoicePayments(balance,clientId,day,local.filter(p=>p.day===day),remote.filter(p=>p.day===day),serverInvoices);
  balance=result.balance;pendingAmount+=result.pendingAmount;if(!Number.isSafeInteger(pendingAmount))throw Error('Montant en attente trop élevé.');
 }
 return {balance,pendingAmount};
}
