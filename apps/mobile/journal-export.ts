import type {OwnedCredit} from './credit-owned-reference-prototype';
import type {LocalSaleRefund,InitialSalePayment} from './credit-sale-refund-journal-prototype';
import type { JournalRow } from './journal.js';
import type { Settlement, TourJournalReceipt } from './storage.js';
import type {Note} from './credit-note-offline-prototype';
import {canonicalJson,prepareFullCreditNote,calculatePreInvoiceCancellation} from '@sls/domain';
import {tunisDay} from './journal';

/** Instantané local, distinct du journal consolidé reçu sur le serveur. */
export type JournalExport = { day: string; commercial: string; rows: JournalRow[]; receipts: TourJournalReceipt[]; settlements?: Settlement[]; clientSectors?: Record<string,string>; credits?: {note:Note;pending:boolean}[]; remoteOwnedCredits?:OwnedCredit[]; ownedLocalCreditOperationIds?:string[]; creditOwnersKnown?:boolean; remoteCancellations?: {kind:'sale'|'preinvoice';invoiceId:string;day:string;source:unknown}[]; remoteSaleUpdates?: {saleId:string;day:string}[]; saleRefunds?: LocalSaleRefund[]; initialSalePayments?:InitialSalePayment[]; adminRefundAssignmentsKnown?:boolean; adminCreditRefunds?:{noteOperationId:string;assignmentId:string;invoiceId:string;kind:'sale'|'preinvoice';clientId:string;clientName:string;recordedAt:string;assignedAt:string;refund:number}[]; remoteSaleRefunds?: {operationId:string;invoiceId:string;clientId:string;clientName:string;recordedAt:string;refund:number}[] };
const amount = (value: number) => {
 if (!Number.isSafeInteger(value)) throw new Error('Montant invalide dans le journal.');
 const n = BigInt(value), abs = n < 0n ? -n : n;
 return `${n < 0n ? '-' : ''}${abs / 1000n},${(abs % 1000n).toString().padStart(3, '0')}`;
};
const sum = (values: number[]) => { const n=values.reduce((a,b)=>a+BigInt(b),0n); if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw Error('Total trop élevé'); return Number(n); };
const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
// Neutralise les formules de tableur même après espaces et caractères de contrôle.
const cell = (value: unknown) => { let s=String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+@\-\t\r]/.test(s)) s="'"+s; return '"'+s.replace(/"/g,'""')+'"'; };
function creditEvents(data:JournalExport) {
  const seen=new Set<string>(),entities=new Set<string>();
  const events=(data.credits??[]).map(({note,pending})=>{
   if(!note||!note.command||typeof pending!=='boolean'||seen.has(note.command.operationId))throw Error('Avoir local invalide ou dupliqué.');
   seen.add(note.command.operationId);const entity=`${note.kind}:${note.command.invoiceId}`;if(entities.has(entity))throw Error('Facture annulée plusieurs fois.');entities.add(entity);
   const source=note.source as Record<string,any>|null;
   if(!source||typeof source!=='object'||!['sale','preinvoice'].includes(note.kind))throw Error('Source de l’avoir invalide.');
   let name:string,invoiceTotal:number,invoiceDay:string,calculated:{balanceDelta:number;refund:number;retainedCredit:number};
   if(note.kind==='sale') {
    if(source.syncSaleId!==note.command.invoiceId||source.syncVersion!==note.command.expectedVersion)throw Error('Facture de l’avoir incohérente.');
    name=source.clientName;invoiceTotal=source.total;invoiceDay=tunisDay(new Date(source.createdAt));
    calculated=prepareFullCreditNote({actor:{id:note.commercialId,role:'commercial'},command:note.command,source:{invoiceId:source.syncSaleId,version:source.syncVersion,total:source.total,netPaid:source.paid,cancelled:false},daysOpen:true,previous:null}).event;
   } else {
    // Vérifie identifiant, acteur et date de la commande indépendamment du calcul.
    prepareFullCreditNote({actor:{id:note.commercialId,role:'commercial'},command:{...note.command,choice:null},source:{invoiceId:note.command.invoiceId,version:note.command.expectedVersion,total:0,netPaid:0,cancelled:false},daysOpen:true,previous:null});
    if(source.invoice?.id!==note.command.invoiceId||source.version!==note.command.expectedVersion||!Array.isArray(source.receipts))throw Error('Facture préétablie de l’avoir incohérente.');
    name=source.invoice.clientName;invoiceTotal=source.invoice.amount;invoiceDay=source.invoice.journalDate;
    if(typeof invoiceDay!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDay))throw Error('Date de facture invalide.');
    calculated=calculatePreInvoiceCancellation({balance:0,invoiceTotal,receipts:source.receipts,alreadyCancelled:false,choice:note.command.choice??undefined});
   }
   if(typeof name!=='string'||!name.trim()||calculated.balanceDelta!==note.balanceDelta||calculated.refund!==note.refund||calculated.retainedCredit!==note.retainedCredit)throw Error('Montants de l’avoir incohérents.');
   return {note,pending,name,invoiceTotal,invoiceDay,day:tunisDay(new Date(note.command.recordedAt))};
  });
 return events;
}
export function initialSalePaymentMap(data:JournalExport):Map<number,number>|null {
 if(data.initialSalePayments===undefined)return null;
 const sales=data.rows.flatMap(r=>r.sales),map=new Map<number,number>();
 for(const item of data.initialSalePayments){
  if(!Number.isSafeInteger(item.saleId)||item.saleId<1||!Number.isSafeInteger(item.paid)||item.paid<0||map.has(item.saleId)||!sales.some(s=>s.id===item.saleId))throw Error('Paiement initial de vente invalide.');
  map.set(item.saleId,item.paid);
 }
 if(map.size!==sales.length||sales.some(s=>!map.has(s.id)))throw Error('Paiements initiaux incomplets.');
 return map;
}
function lines(data: JournalExport): string[][] {
 const initial=initialSalePaymentMap(data);
 const allEvents=creditEvents(data),byInvoice=new Map(allEvents.map(e=>[`${e.note.kind}:${e.note.command.invoiceId}`,e]));
 const remoteByInvoice=new Map<string,NonNullable<JournalExport['remoteCancellations']>[number]>();
 for(const entry of data.remoteCancellations??[]){
  const key=`${entry.kind}:${entry.invoiceId}`,parsed=new Date(`${entry.day}T00:00:00.000Z`);
  if(!['sale','preinvoice'].includes(entry.kind)||typeof entry.invoiceId!=='string'||!entry.invoiceId||!/^\d{4}-\d{2}-\d{2}$/.test(entry.day)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==entry.day||!entry.source||typeof entry.source!=='object'||Array.isArray(entry.source)||byInvoice.has(key)||remoteByInvoice.has(key))throw Error('Annulation distante invalide.');
  remoteByInvoice.set(key,entry);
 }
 const localOwned=data.ownedLocalCreditOperationIds===undefined?null:new Set(data.ownedLocalCreditOperationIds);
 if(localOwned&&(localOwned.size!==data.ownedLocalCreditOperationIds!.length||[...localOwned].some(id=>!allEvents.some(e=>e.note.command.operationId===id))))throw Error('Origine des avoirs locaux invalide.');
 const ownedIds=new Set<string>();
 for(const e of data.remoteOwnedCredits??[]){
  const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  const invoiceDay=e.invoiceDay?new Date(`${e.invoiceDay}T00:00:00.000Z`):null;
  if(!uuid(e.operationId)||!uuid(e.invoiceId)||!uuid(e.clientId)||!['sale','preinvoice'].includes(e.kind)||!['admin','commercial'].includes(e.actorRole)||typeof e.actorId!=='string'||!e.actorId.trim()||typeof e.clientName!=='string'||!e.clientName.trim()||!Number.isFinite(Date.parse(e.recordedAt))||tunisDay(new Date(e.recordedAt))!==data.day||typeof e.invoiceDay!=='string'||(e.kind==='preinvoice'&&(!invoiceDay||!Number.isFinite(invoiceDay.getTime())||invoiceDay.toISOString().slice(0,10)!==e.invoiceDay))||![e.invoiceTotal,e.refund,e.retainedCredit].every(v=>Number.isSafeInteger(v)&&v>=0)||e.refund+e.retainedCredit>e.invoiceTotal||ownedIds.has(e.operationId)||allEvents.some(x=>x.note.command.operationId===e.operationId))throw Error('Avoir distant du propriétaire invalide.');
  ownedIds.add(e.operationId);
 }
 const updates=new Map<string,string>();
 for(const entry of data.remoteSaleUpdates??[]){
  const parsed=new Date(`${entry.day}T00:00:00.000Z`);
  if(typeof entry.saleId!=='string'||!entry.saleId||updates.has(entry.saleId)||!/^\d{4}-\d{2}-\d{2}$/.test(entry.day)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==entry.day||!data.rows.some(r=>r.sales.some(s=>s.syncSaleId===entry.saleId)))throw Error('Modification distante invalide.');
  updates.set(entry.saleId,entry.day);
 }
 const rows: string[][] = [
  ['Journal de tournée — instantané local (données fictives)'],
  ['Date',data.day,'Commercial',data.commercial],
  ['Périmètre','Opérations présentes sur ce téléphone, avoirs sur les factures du commercial et remboursements administrateur attribués reçus à la dernière synchronisation ; les autres opérations ne sont pas incluses.'],
  ['Client','Secteur','Type','Référence locale / date','Montant facture DT','Paiement facture DT','Ancienne dette réglée DT','Mode','Total client DT'],
 ];
 for(const r of data.rows){
  rows.push([r.clientName,r.sector,'Synthèse client','',amount(r.preInvoice?.amount ?? 0),'','','',amount(r.total)]);
  if(r.preInvoice) {
   const key=`preinvoice:${r.preInvoice.id}`,e=byInvoice.get(key),remote=remoteByInvoice.get(key),source=(e?.note.source??remote?.source) as {invoice:unknown;receipts:unknown}|undefined;
   if(source){const receipts=data.receipts.filter(p=>p.preInvoiceId===r.preInvoice!.id);if(canonicalJson(source.invoice)!==canonicalJson(r.preInvoice)||canonicalJson(source.receipts)!==canonicalJson(receipts))throw Error('Facture préétablie modifiée après avoir : export refusé.');}
   const label=e?` · avoir du ${e.day} · ${e.pending?'en attente':'synchronisé'}`:remote?` · avoir du ${remote.day} · enregistré ailleurs`:'';
   rows.push([r.clientName,r.sector,e||remote?'Facture préétablie — annulée par avoir':'Facture préétablie',`${r.preInvoice.id}${label}`,amount(r.preInvoice.amount),'','','','']);
  }
  for(const s of r.sales){
   const key=`sale:${s.syncSaleId}`,e=s.syncSaleId?byInvoice.get(key):undefined,remote=s.syncSaleId?remoteByInvoice.get(key):undefined;
   if(e||remote){const {id:_id,...source}=s;if(canonicalJson(source)!==canonicalJson(e?.note.source??remote?.source))throw Error('Vente modifiée après avoir : export refusé.');}
   const label=e?` · avoir du ${e.day} · ${e.pending?'en attente':'synchronisé'}`:remote?` · avoir du ${remote.day} · enregistré ailleurs`:'';
   const update=s.syncSaleId&&updates.get(s.syncSaleId)?` · modification du ${updates.get(s.syncSaleId)} enregistrée ailleurs`:'';
   rows.push([r.clientName,r.sector,e||remote?'Vente supplémentaire — annulée par avoir':'Vente supplémentaire',`Vente locale ${s.id}${label}${update}`,amount(s.total),amount(initial?.get(s.id)??s.paid),'',s.paymentMode,'']);
  }
  for(const p of data.receipts.filter(p=>p.clientId===r.clientId && p.journalDate===data.day)) rows.push([r.clientName,r.sector,p.creditFull?'Journal — crédit total':'Règlement journal',p.createdAt,'',amount(p.prePaid),amount(p.oldDebtPaid),p.mode,'']);
 }
 rows.push(['TOTAL FACTURÉ (préétabli + ventes)','','','','','','','',amount(sum(data.rows.map(r=>r.total)))]);
 const journalReceipts=data.receipts.filter(p=>p.journalDate===data.day && data.rows.some(r=>r.clientId===p.clientId));
 rows.push(['TOTAL PAIEMENTS FACTURE PRÉÉTABLIE','','','','',amount(sum(journalReceipts.map(p=>p.prePaid)))]);
 rows.push(['TOTAL ANCIENNE DETTE RÉGLÉE','','','','','',amount(sum(journalReceipts.map(p=>p.oldDebtPaid)))]);
 rows.push([initial?'TOTAL ENCAISSÉ LOCAL AVANT REMBOURSEMENTS':'TOTAL ENCAISSÉ LOCAL AVANT AVOIRS ET REMBOURSEMENTS DISTANTS','','','','',amount(sum([...journalReceipts.flatMap(p=>[p.prePaid,p.oldDebtPaid]),...data.rows.flatMap(r=>r.sales.map(s=>initial?.get(s.id)??s.paid))]))]);
 if(data.saleRefunds){
  const seen=new Set<string>();
  rows.push([initial?'REMBOURSEMENTS DE MODIFICATIONS — SORTIES LOCALES DU JOUR':'REMBOURSEMENTS DE MODIFICATIONS — DÉJÀ INCLUS DANS LES PAIEMENTS NETS']);
  for(const r of data.saleRefunds){
   const key=String(r.revisionId);
   if(!Number.isSafeInteger(r.revisionId)||r.revisionId<1||!Number.isSafeInteger(r.saleId)||r.saleId<1||typeof r.clientId!=='string'||typeof r.clientName!=='string'||!r.clientName.trim()||!Number.isSafeInteger(r.refund)||r.refund<=0||!Number.isFinite(Date.parse(r.recordedAt))||tunisDay(new Date(r.recordedAt))!==data.day||(!initial&&!data.rows.some(row=>row.clientId===r.clientId&&row.sales.some(s=>s.id===r.saleId)))||seen.has(key))throw Error('Remboursement de vente invalide.');
   seen.add(key);rows.push([r.clientName,'','Remboursement de modification',`Vente locale ${r.saleId} · ${r.recordedAt}`,'',amount(r.refund)]);
  }
  rows.push(['TOTAL REMBOURSEMENTS DE MODIFICATIONS','','','','',amount(sum(data.saleRefunds.map(r=>r.refund)))]);
  rows.push(['Note remboursements',initial?'Ces sorties sont déduites une seule fois du paiement initial, à la date de modification. L’enregistrement ne prouve pas le versement physique.':'Déjà inclus dans les paiements nets : ne pas les déduire à nouveau. L’enregistrement ne prouve pas le versement physique.']);
 }
 const remoteRefunds=data.remoteSaleRefunds??[],seenRemote=new Set<string>();
 if(data.remoteSaleRefunds&&!data.credits)throw Error('Avoirs locaux indisponibles.');
 if(data.remoteSaleRefunds){
  rows.push(['REMBOURSEMENTS SUR VENTES D’AUTRES APPAREILS — SORTIES DE CE TÉLÉPHONE']);
  for(const r of remoteRefunds){
   const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
   if(!uuid(r.operationId)||!uuid(r.invoiceId)||!uuid(r.clientId)||typeof r.clientName!=='string'||!r.clientName.trim()||!Number.isSafeInteger(r.refund)||r.refund<=0||typeof r.recordedAt!=='string'||!Number.isFinite(Date.parse(r.recordedAt))||tunisDay(new Date(r.recordedAt))!==data.day||data.rows.some(row=>row.sales.some(s=>s.syncSaleId===r.invoiceId))||seenRemote.has(r.operationId))throw Error('Remboursement distant invalide.');
   seenRemote.add(r.operationId);rows.push([r.clientName,'','Remboursement vente d’un autre appareil',`${r.invoiceId} · ${r.recordedAt}`,'',amount(r.refund)]);
  }
  rows.push(['TOTAL REMBOURSEMENTS SUR VENTES D’AUTRES APPAREILS','','','','',amount(sum(remoteRefunds.map(r=>r.refund)))]);
  rows.push(['Note remboursements distants','Ces sorties sont retranchées de l’encaissé local ci-dessous. Leur enregistrement ne prouve pas le versement physique.']);
 }
 const adminRefunds=data.adminCreditRefunds??[],seenAdmin=new Set<string>();
 if(data.adminCreditRefunds&&!data.credits)throw Error('Avoirs locaux indisponibles.');
 if(data.adminCreditRefunds){
  rows.push(['REMBOURSEMENTS ADMINISTRATEUR ATTRIBUÉS À CE COMMERCIAL']);
  const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  for(const r of adminRefunds){
   if(!uuid(r.noteOperationId)||!uuid(r.assignmentId)||!uuid(r.invoiceId)||!uuid(r.clientId)||!['sale','preinvoice'].includes(r.kind)||typeof r.clientName!=='string'||!r.clientName.trim()||!Number.isSafeInteger(r.refund)||r.refund<=0||!Number.isFinite(Date.parse(r.recordedAt))||!Number.isFinite(Date.parse(r.assignedAt))||tunisDay(new Date(r.recordedAt))!==data.day||seenAdmin.has(r.noteOperationId)||allEvents.some(e=>e.note.command.operationId===r.noteOperationId))throw Error('Attribution de remboursement invalide.');
   seenAdmin.add(r.noteOperationId);rows.push([r.clientName,'',r.kind==='sale'?'Remboursement admin — vente':'Remboursement admin — préétablie',`${r.invoiceId} · ${r.recordedAt} · attribution ${r.assignedAt}`,'',amount(r.refund)]);
  }
  rows.push(['TOTAL REMBOURSEMENTS ADMIN ATTRIBUÉS','','','','',amount(sum(adminRefunds.map(r=>r.refund)))]);
  rows.push(['Note attribution','Données reçues du serveur lors de la dernière synchronisation. L’attribution ne prouve pas le versement physique.']);
 }
 if(data.adminRefundAssignmentsKnown===false)rows.push(['Attention','Attributions administrateur indisponibles dans cette ancienne référence : synchronisez pour actualiser le journal.']);
 if(data.credits) {
  let total=0n,refund=0n;
  const events=allEvents.filter(e=>e.day===data.day);
  rows.push(['AVOIRS CRÉÉS CE JOUR — distincts des factures d’origine']);
  for(const e of events){
   if(!localOwned||localOwned.has(e.note.command.operationId))total+=BigInt(e.invoiceTotal);refund+=BigInt(e.note.refund);
   rows.push([e.name,'',e.note.kind==='sale'?'Avoir vente':'Avoir facture préétablie',`${e.note.command.invoiceId} · facture du ${e.invoiceDay} · ${e.pending?'en attente':'synchronisé'}${localOwned&&!localOwned.has(e.note.command.operationId)?' · facture hors facturé de ce commercial ou propriété à confirmer':''}`,(!localOwned||localOwned.has(e.note.command.operationId))?amount(-e.invoiceTotal):'',amount(e.note.refund),'',e.note.retainedCredit?`Crédit conservé ${amount(e.note.retainedCredit)} DT`:'','']);
  }
  for(const e of data.remoteOwnedCredits??[])total+=BigInt(e.invoiceTotal);
  const billed=sum(data.rows.map(r=>r.total)),gross=sum([...journalReceipts.flatMap(p=>[p.prePaid,p.oldDebtPaid]),...data.rows.flatMap(r=>r.sales.map(s=>initial?.get(s.id)??s.paid))]);
  const asSafe=(n:bigint)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw Error('Total trop élevé');return Number(n);};
  rows.push(['TOTAL AVOIRS DU JOUR','','','',amount(asSafe(total))]);
  rows.push(['FACTURÉ DU JOUR MOINS AVOIRS DU JOUR','','','','','','','',amount(asSafe(BigInt(billed)-total))]);
  rows.push(['REMBOURSEMENTS DES AVOIRS DU JOUR','','','','',amount(asSafe(refund))]);
  const remoteRefundTotal=BigInt(sum(remoteRefunds.map(r=>r.refund)));
  rows.push(['ENCAISSÉ LOCAL APRÈS REMBOURSEMENTS DES VENTES ET AVOIRS','','','','',amount(asSafe(BigInt(gross)-refund-remoteRefundTotal-BigInt(sum(adminRefunds.map(r=>r.refund)))-(initial?BigInt(sum((data.saleRefunds??[]).map(r=>r.refund))):0n)))]);
  rows.push(['Note avoirs','Les avoirs sont datés du jour de création, même si la facture est d’un autre jour. Les paiements d’ancienne dette sont conservés. Une préétablie reste à corriger séparément dans le système principal.']);
 }
 if(data.creditOwnersKnown===false)rows.push(['Attention','Propriétaires des avoirs indisponibles dans cette ancienne référence : synchronisez.']);
 if(data.remoteOwnedCredits?.length){
  rows.push(['AVOIRS ENREGISTRÉS AILLEURS SUR LES FACTURES DE CE COMMERCIAL — INFORMATION SERVEUR']);
  for(const e of data.remoteOwnedCredits)rows.push([e.clientName,'',e.kind==='sale'?'Avoir distant — vente':'Avoir distant — préétablie',`${e.invoiceId} · ${e.actorRole==='admin'?'administrateur':'autre appareil ou commercial'}${e.invoiceDay?` · facture du ${e.invoiceDay}`:''}`,amount(e.invoiceTotal),amount(e.refund),'',e.retainedCredit?`Crédit conservé ${amount(e.retainedCredit)} DT`:'']);
  rows.push(['Attention','Ces avoirs reçus du serveur sont déduits du facturé à la date de création de l’avoir. Leur remboursement appartient à la caisse de son auteur ou à la caisse attribuée, pas automatiquement à celle du propriétaire.']);
 }
 if(updates.size)rows.push(['Modifications enregistrées ailleurs','Les ventes indiquées ont été actualisées depuis un autre appareil. Les remboursements effectués ailleurs ne sont pas déduits de la caisse de ce téléphone.']);
 if(remoteByInvoice.size)rows.push(['Annulations enregistrées ailleurs','Les factures sont signalées comme annulées. Les avoirs reçus sur les factures de ce commercial sont déduits à leur date de création ; seuls les remboursements attribués à cette caisse sont déduits de l’encaissé. Consultez le journal serveur.']);
 rows.push(['NOMBRE DE CLIENTS',String(data.rows.length)]);
 rows.push(['Note','Le total facturé ne représente pas un chiffre d’affaires consolidé. Les ventes affichent leur état actuel, pas leur historique de corrections.']);
 return rows;
}
export function journalCsv(data: JournalExport): string { return '\uFEFF'+lines(data).map(r=>r.map(cell).join(';')).join('\r\n')+'\r\n'; }
/** PDF synthétique : un client par ligne. Le CSV détaillé reste inchangé.
 * La charge n'est pas encore saisie dans l'application : ne jamais inventer 0. */
export function journalHtml(data: JournalExport): string {
 lines(data); // Conserve les validations des avoirs, remboursements et références.
 const initial=initialSalePaymentMap(data),rows=new Map<string,JournalRow>();
 for(const row of data.rows){
  if(!row.clientId||rows.has(row.clientId)||!row.clientName?.trim())throw Error('Client du journal invalide ou dupliqué.');
  const calculated=sum([row.preInvoice?.amount??0,...row.sales.map(s=>s.total)]);
  if(calculated!==row.total||row.sales.some(s=>s.clientId!==row.clientId)||row.preInvoice&&row.preInvoice.clientId!==row.clientId)throw Error('Total ou client du journal incohérent.');
  rows.set(row.clientId,{...row});
 }
 const selectedSettlements:NonNullable<JournalExport['settlements']>=[],seenSettlements=new Set<number>();
 for(const payment of data.settlements??[]){
  if(!Number.isSafeInteger(payment.id)||payment.id<1||seenSettlements.has(payment.id)||!payment.clientId||!payment.clientName?.trim()||!Number.isSafeInteger(payment.amount)||payment.amount<=0||!['Espèces','Chèque','Virement'].includes(payment.mode)||!Number.isFinite(Date.parse(payment.createdAt)))throw Error('Règlement de dette invalide dans le journal.');
  seenSettlements.add(payment.id);if(tunisDay(new Date(payment.createdAt))!==data.day)continue;
  selectedSettlements.push(payment);
  if(!rows.has(payment.clientId))rows.set(payment.clientId,{clientId:payment.clientId,clientName:payment.clientName,sector:data.clientSectors?.[payment.clientId]??'',preInvoice:null,sales:[],total:0});
 }
 const receipts=data.receipts.filter(r=>r.journalDate===data.day);
 const seenReceipts=new Set<string>();
 for(const p of receipts){
  const row=rows.get(p.clientId);
  if(!p.id||seenReceipts.has(p.id)||!row?.preInvoice||row.preInvoice.id!==p.preInvoiceId||!Number.isSafeInteger(p.prePaid)||p.prePaid<0||!Number.isSafeInteger(p.oldDebtPaid)||p.oldDebtPaid<0||!['Espèces','Chèque','Virement'].includes(p.mode))throw Error('Règlement du journal incohérent.');
  seenReceipts.add(p.id);
 }
 const ordered=[...rows.values()].sort((a,b)=>a.clientName.localeCompare(b.clientName));
 const sectors=[...new Set(ordered.map(r=>r.sector.trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
 const unknownSector=ordered.some(r=>!r.sector.trim());
 const sectorText=sectors.length?sectors.join(', ')+(unknownSector?' · secteur non renseigné pour certains clients':''):'Non renseigné';
 const byMode=(entries:{mode:string;value:number}[])=>{
  const grouped=new Map<string,number[]>();
  for(const {mode,value} of entries){if(!Number.isSafeInteger(value)||value<0||!['Espèces','Chèque','Virement','Crédit'].includes(mode)||value>0&&mode==='Crédit')throw Error('Mode ou montant de paiement invalide.');if(value>0){const list=grouped.get(mode)??[];list.push(value);grouped.set(mode,list);}}
  return [...grouped].map(([mode,values])=>`${mode} ${amount(sum(values))}`).join(' · ');
 };
 let billed=0,preTotal=0,saleTotal=0,oldTotal=0;
 const table=ordered.map(row=>{
  const clientReceipts=receipts.filter(p=>p.clientId===row.clientId),clientSettlements=selectedSettlements.filter(p=>p.clientId===row.clientId);
  const prePaid=sum(clientReceipts.map(p=>p.prePaid)),salePaid=sum(row.sales.map(s=>initial?.get(s.id)??s.paid)),old=sum([...clientReceipts.map(p=>p.oldDebtPaid),...clientSettlements.map(p=>p.amount)]);
  const supplementary=sum(row.sales.map(s=>s.total)),bill=row.total;
  billed=sum([billed,bill]);preTotal=sum([preTotal,prePaid]);saleTotal=sum([saleTotal,salePaid]);oldTotal=sum([oldTotal,old]);
  const paymentMode=byMode([...clientReceipts.map(p=>({mode:p.mode,value:p.prePaid})),...row.sales.map(s=>({mode:s.paymentMode,value:initial?.get(s.id)??s.paid}))]);
  const oldMode=byMode([...clientReceipts.map(p=>({mode:p.mode,value:p.oldDebtPaid})),...clientSettlements.map(p=>({mode:p.mode,value:p.amount}))]);
  const payment=`${amount(sum([prePaid,salePaid]))}${paymentMode?` · ${paymentMode}`:''}`;
  const debt=`${amount(old)}${oldMode?` · ${oldMode}`:''}${data.settlements===undefined?' · règlements séparés indisponibles':''}`;
  return [row.clientName,amount(row.preInvoice?.amount??0),amount(supplementary),payment,debt,amount(bill)];
 });
 const gross=sum([preTotal,saleTotal,oldTotal]);
 const notices:string[]=[];
 if(data.settlements===undefined)notices.push('Règlements séparés de dette indisponibles : les montants affichés ne comprennent que les paiements du journal.');
 if(!initial)notices.push('Paiements de ventes : montants nets actuellement enregistrés ; les remboursements de modification peuvent y être déjà inclus.');
 if(data.remoteSaleUpdates?.length)notices.push('Modifications enregistrées ailleurs : consultez le CSV détaillé.');
 if(data.credits?.length||data.remoteCancellations?.length||data.remoteOwnedCredits?.length||data.saleRefunds?.length||data.remoteSaleRefunds?.length||data.adminCreditRefunds?.length){
  notices.push('Ce récapitulatif est avant déduction des avoirs et remboursements. Consultez le CSV détaillé pour les mouvements et leur statut ; leur enregistrement ne prouve pas le versement physique.');
  if(data.credits?.some(x=>x.note.kind==='preinvoice')||data.remoteCancellations?.some(x=>x.kind==='preinvoice')||data.remoteOwnedCredits?.some(x=>x.kind==='preinvoice'))notices.push('Une facture préétablie annulée doit être corrigée séparément dans le système principal.');
 }
 const headers=['Client','Mt FC préétablie','Mt FC supplémentaire','Paiement FC du jour · mode','Ancienne dette réglée · mode','Total client'];
 const summary=[['Total facturé (préétablie + supplémentaire)',amount(billed)],['Total paiements facture préétablie',amount(preTotal)],['Total paiements facture supplémentaire',amount(saleTotal)],['Total charges','Non renseigné'],['Total encaissé local avant avoirs et remboursements distants',amount(gross)],['Nombre de clients',String(ordered.length)]];
 return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>@page{size:A4 landscape;margin:12mm}body{font-family:Arial,sans-serif;color:#193c35;font-size:10px}h1{font-size:20px}p{font-size:10px}table{width:100%;border-collapse:collapse;table-layout:fixed}td,th{border:1px solid #b7c9bf;padding:5px;text-align:left;overflow-wrap:anywhere}th{background:#d8eee2}tr{page-break-inside:avoid}.totals{margin-top:12px;width:68%}.totals td:last-child{text-align:right;font-weight:bold}.notice{color:#754b20}</style></head><body><h1>Journal de tournée — instantané local</h1><p>Date : ${escapeHtml(data.day)} · Commercial : ${escapeHtml(data.commercial)}<br>Secteur(s) des clients du jour : ${escapeHtml(sectorText)}</p><p>Opérations présentes sur ce téléphone. Les autres appareils ne sont pas inclus. Les charges ne sont pas encore saisies dans l’application et ne sont pas déduites de l’encaissé.</p><table><thead><tr>${headers.map(x=>`<th>${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${table.map(row=>`<tr>${row.map(x=>`<td>${escapeHtml(x)}</td>`).join('')}</tr>`).join('')}</tbody></table><table class="totals"><tbody>${summary.map(row=>`<tr><td>${escapeHtml(row[0])}</td><td>${escapeHtml(row[1])}</td></tr>`).join('')}</tbody></table>${notices.map(text=>`<p class="notice">${escapeHtml(text)}</p>`).join('')}</body></html>`;
}
