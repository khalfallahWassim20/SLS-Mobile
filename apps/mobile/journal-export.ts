import type { JournalRow } from './journal.js';
import type { TourJournalReceipt } from './storage.js';

/** Instantané local, distinct du journal consolidé reçu sur le serveur. */
export type JournalExport = { day: string; commercial: string; rows: JournalRow[]; receipts: TourJournalReceipt[] };
const amount = (value: number) => {
 if (!Number.isSafeInteger(value)) throw new Error('Montant invalide dans le journal.');
 const n = BigInt(value), abs = n < 0n ? -n : n;
 return `${n < 0n ? '-' : ''}${abs / 1000n},${(abs % 1000n).toString().padStart(3, '0')}`;
};
const sum = (values: number[]) => { const n=values.reduce((a,b)=>a+BigInt(b),0n); if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw Error('Total trop élevé'); return Number(n); };
const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
// Neutralise les formules de tableur même après espaces et caractères de contrôle.
const cell = (value: unknown) => { let s=String(value ?? ''); if (/^[\s\u0000-\u001f]*[=+@\-\t\r]/.test(s)) s="'"+s; return '"'+s.replace(/"/g,'""')+'"'; };
function lines(data: JournalExport): string[][] {
 const rows: string[][] = [
  ['Journal de tournée — instantané local (données fictives)'],
  ['Date',data.day,'Commercial',data.commercial],
  ['Périmètre','Opérations présentes sur ce téléphone uniquement ; les autres appareils et opérations non présentes ne sont pas inclus.'],
  ['Client','Secteur','Type','Référence locale / date','Montant facture DT','Paiement facture DT','Ancienne dette réglée DT','Mode','Total client DT'],
 ];
 for(const r of data.rows){
  rows.push([r.clientName,r.sector,'Synthèse client','',amount(r.preInvoice?.amount ?? 0),'','','',amount(r.total)]);
  if(r.preInvoice) rows.push([r.clientName,r.sector,'Facture préétablie',r.preInvoice.id,amount(r.preInvoice.amount),'','','','']);
  for(const s of r.sales) rows.push([r.clientName,r.sector,'Vente supplémentaire',`Vente locale ${s.id}`,amount(s.total),amount(s.paid),'',s.paymentMode,'']);
  for(const p of data.receipts.filter(p=>p.clientId===r.clientId && p.journalDate===data.day)) rows.push([r.clientName,r.sector,p.creditFull?'Journal — crédit total':'Règlement journal',p.createdAt,'',amount(p.prePaid),amount(p.oldDebtPaid),p.mode,'']);
 }
 rows.push(['TOTAL FACTURÉ (préétabli + ventes)','','','','','','','',amount(sum(data.rows.map(r=>r.total)))]);
 const journalReceipts=data.receipts.filter(p=>p.journalDate===data.day && data.rows.some(r=>r.clientId===p.clientId));
 rows.push(['TOTAL PAIEMENTS FACTURE PRÉÉTABLIE','','','','',amount(sum(journalReceipts.map(p=>p.prePaid)))]);
 rows.push(['TOTAL ANCIENNE DETTE RÉGLÉE','','','','','',amount(sum(journalReceipts.map(p=>p.oldDebtPaid)))]);
 rows.push(['TOTAL ENCAISSÉ LOCAL','','','','',amount(sum([...journalReceipts.flatMap(p=>[p.prePaid,p.oldDebtPaid]),...data.rows.flatMap(r=>r.sales.map(s=>s.paid))]))]);
 rows.push(['NOMBRE DE CLIENTS',String(data.rows.length)]);
 rows.push(['Note','Le total facturé ne représente pas un chiffre d’affaires consolidé. Les ventes affichent leur état actuel, pas leur historique de corrections.']);
 return rows;
}
export function journalCsv(data: JournalExport): string { return '\uFEFF'+lines(data).map(r=>r.map(cell).join(';')).join('\r\n')+'\r\n'; }
export function journalHtml(data: JournalExport): string {
 const dataRows=lines(data);
 return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;color:#193c35;font-size:10px}h1{font-size:22px}p{font-size:11px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #b7c9bf;padding:5px;text-align:left;overflow-wrap:anywhere}th{background:#d8eee2}tr{page-break-inside:avoid}</style></head><body><h1>Journal de tournée — instantané local</h1><p>Date : ${escapeHtml(data.day)} · Commercial : ${escapeHtml(data.commercial)}</p><p>Données fictives. Opérations présentes sur ce téléphone uniquement. Les autres appareils et opérations non présentes ne sont pas inclus. Le total facturé n’est pas un chiffre d’affaires consolidé. Les ventes affichent leur état actuel, pas leur historique de corrections.</p><table><thead><tr>${dataRows[3].map(x=>`<th>${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${dataRows.slice(4,-1).map(r=>`<tr>${r.map(x=>`<td>${escapeHtml(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
}
