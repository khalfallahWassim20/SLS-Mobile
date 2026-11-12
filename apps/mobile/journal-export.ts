import type {LocalSaleRefund} from './credit-sale-refund-journal-prototype';
import type { JournalRow } from './journal.js';
import type { TourJournalReceipt } from './storage.js';
import type {Note} from './credit-note-offline-prototype';
import {canonicalJson,prepareFullCreditNote,calculatePreInvoiceCancellation} from '@sls/domain';
import {tunisDay} from './journal';

/** Instantané local, distinct du journal consolidé reçu sur le serveur. */
export type JournalExport = { day: string; commercial: string; rows: JournalRow[]; receipts: TourJournalReceipt[]; credits?: {note:Note;pending:boolean}[]; remoteCancellations?: {kind:'sale'|'preinvoice';invoiceId:string;day:string;source:unknown}[]; remoteSaleUpdates?: {saleId:string;day:string}[]; saleRefunds?: LocalSaleRefund[]; remoteSaleRefunds?: {operationId:string;invoiceId:string;clientId:string;clientName:string;recordedAt:string;refund:number}[] };
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
function lines(data: JournalExport): string[][] {
 const allEvents=creditEvents(data),byInvoice=new Map(allEvents.map(e=>[`${e.note.kind}:${e.note.command.invoiceId}`,e]));
 const remoteByInvoice=new Map<string,NonNullable<JournalExport['remoteCancellations']>[number]>();
 for(const entry of data.remoteCancellations??[]){
  const key=`${entry.kind}:${entry.invoiceId}`,parsed=new Date(`${entry.day}T00:00:00.000Z`);
  if(!['sale','preinvoice'].includes(entry.kind)||typeof entry.invoiceId!=='string'||!entry.invoiceId||!/^\d{4}-\d{2}-\d{2}$/.test(entry.day)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==entry.day||!entry.source||typeof entry.source!=='object'||Array.isArray(entry.source)||byInvoice.has(key)||remoteByInvoice.has(key))throw Error('Annulation distante invalide.');
  remoteByInvoice.set(key,entry);
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
  ['Périmètre','Opérations présentes sur ce téléphone uniquement ; les autres appareils et opérations non présentes ne sont pas inclus.'],
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
   rows.push([r.clientName,r.sector,e||remote?'Vente supplémentaire — annulée par avoir':'Vente supplémentaire',`Vente locale ${s.id}${label}${update}`,amount(s.total),amount(s.paid),'',s.paymentMode,'']);
  }
  for(const p of data.receipts.filter(p=>p.clientId===r.clientId && p.journalDate===data.day)) rows.push([r.clientName,r.sector,p.creditFull?'Journal — crédit total':'Règlement journal',p.createdAt,'',amount(p.prePaid),amount(p.oldDebtPaid),p.mode,'']);
 }
 rows.push(['TOTAL FACTURÉ (préétabli + ventes)','','','','','','','',amount(sum(data.rows.map(r=>r.total)))]);
 const journalReceipts=data.receipts.filter(p=>p.journalDate===data.day && data.rows.some(r=>r.clientId===p.clientId));
 rows.push(['TOTAL PAIEMENTS FACTURE PRÉÉTABLIE','','','','',amount(sum(journalReceipts.map(p=>p.prePaid)))]);
 rows.push(['TOTAL ANCIENNE DETTE RÉGLÉE','','','','','',amount(sum(journalReceipts.map(p=>p.oldDebtPaid)))]);
 rows.push(['TOTAL ENCAISSÉ LOCAL AVANT AVOIRS ET REMBOURSEMENTS DISTANTS','','','','',amount(sum([...journalReceipts.flatMap(p=>[p.prePaid,p.oldDebtPaid]),...data.rows.flatMap(r=>r.sales.map(s=>s.paid))]))]);
 if(data.saleRefunds){
  const seen=new Set<string>();
  rows.push(['REMBOURSEMENTS DE MODIFICATIONS — DÉJÀ INCLUS DANS LES PAIEMENTS NETS']);
  for(const r of data.saleRefunds){
   const key=String(r.revisionId);
   if(!Number.isSafeInteger(r.revisionId)||r.revisionId<1||!Number.isSafeInteger(r.saleId)||r.saleId<1||typeof r.clientId!=='string'||typeof r.clientName!=='string'||!r.clientName.trim()||!Number.isSafeInteger(r.refund)||r.refund<=0||!Number.isFinite(Date.parse(r.recordedAt))||tunisDay(new Date(r.recordedAt))!==data.day||!data.rows.some(row=>row.clientId===r.clientId&&row.sales.some(s=>s.id===r.saleId))||seen.has(key))throw Error('Remboursement de vente invalide.');
   seen.add(key);rows.push([r.clientName,'','Remboursement de modification',`Vente locale ${r.saleId} · ${r.recordedAt}`,'',amount(r.refund)]);
  }
  rows.push(['TOTAL REMBOURSEMENTS DE MODIFICATIONS','','','','',amount(sum(data.saleRefunds.map(r=>r.refund)))]);
  rows.push(['Note remboursements','Déjà inclus dans les paiements nets : ne pas les déduire à nouveau. L’enregistrement ne prouve pas le versement physique.']);
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
 if(data.credits) {
  let total=0n,refund=0n;
  const events=allEvents.filter(e=>e.day===data.day);
  rows.push(['AVOIRS CRÉÉS CE JOUR — distincts des factures d’origine']);
  for(const e of events){
   total+=BigInt(e.invoiceTotal);refund+=BigInt(e.note.refund);
   rows.push([e.name,'',e.note.kind==='sale'?'Avoir vente':'Avoir facture préétablie',`${e.note.command.invoiceId} · facture du ${e.invoiceDay} · ${e.pending?'en attente':'synchronisé'}`,amount(-e.invoiceTotal),amount(e.note.refund),'',e.note.retainedCredit?`Crédit conservé ${amount(e.note.retainedCredit)} DT`:'','']);
  }
  const billed=sum(data.rows.map(r=>r.total)),gross=sum([...journalReceipts.flatMap(p=>[p.prePaid,p.oldDebtPaid]),...data.rows.flatMap(r=>r.sales.map(s=>s.paid))]);
  const asSafe=(n:bigint)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw Error('Total trop élevé');return Number(n);};
  rows.push(['TOTAL AVOIRS DU JOUR','','','',amount(asSafe(total))]);
  rows.push(['FACTURÉ DU JOUR MOINS AVOIRS DU JOUR','','','','','','','',amount(asSafe(BigInt(billed)-total))]);
  rows.push(['REMBOURSEMENTS DES AVOIRS DU JOUR','','','','',amount(asSafe(refund))]);
  const remoteRefundTotal=BigInt(sum(remoteRefunds.map(r=>r.refund)));
  rows.push(['ENCAISSÉ LOCAL MOINS REMBOURSEMENTS DES AVOIRS ET VENTES DISTANTES','','','','',amount(asSafe(BigInt(gross)-refund-remoteRefundTotal))]);
  rows.push(['Note avoirs','Les avoirs sont datés du jour de création, même si la facture est d’un autre jour. Les paiements d’ancienne dette sont conservés. Une préétablie reste à corriger séparément dans le système principal.']);
 }
 if(updates.size)rows.push(['Modifications enregistrées ailleurs','Les ventes indiquées ont été actualisées depuis un autre appareil. Un remboursement enregistré ailleurs peut empêcher cet export en attendant le rapprochement des encaissements.']);
 if(remoteByInvoice.size)rows.push(['Annulations enregistrées ailleurs','Les factures sont signalées comme annulées. Ces avoirs et leurs remboursements ne sont pas ajoutés aux totaux de ce téléphone ; consultez le journal serveur pour une vue consolidée.']);
 rows.push(['NOMBRE DE CLIENTS',String(data.rows.length)]);
 rows.push(['Note','Le total facturé ne représente pas un chiffre d’affaires consolidé. Les ventes affichent leur état actuel, pas leur historique de corrections.']);
 return rows;
}
export function journalCsv(data: JournalExport): string { return '\uFEFF'+lines(data).map(r=>r.map(cell).join(';')).join('\r\n')+'\r\n'; }
export function journalHtml(data: JournalExport): string {
 const dataRows=lines(data);
 return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;color:#193c35;font-size:10px}h1{font-size:22px}p{font-size:11px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #b7c9bf;padding:5px;text-align:left;overflow-wrap:anywhere}th{background:#d8eee2}tr{page-break-inside:avoid}</style></head><body><h1>Journal de tournée — instantané local</h1><p>Date : ${escapeHtml(data.day)} · Commercial : ${escapeHtml(data.commercial)}</p><p>Données fictives. Opérations présentes sur ce téléphone uniquement. Les autres appareils et opérations non présentes ne sont pas inclus. Le total facturé n’est pas un chiffre d’affaires consolidé. Les ventes affichent leur état actuel, pas leur historique de corrections.</p><table><thead><tr>${dataRows[3].map(x=>`<th>${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${dataRows.slice(4,-1).map(r=>`<tr>${r.map(x=>`<td>${escapeHtml(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
}
