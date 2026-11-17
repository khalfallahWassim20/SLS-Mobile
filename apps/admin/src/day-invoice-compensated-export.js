/** Export de la synthèse serveur après compensation. Ce document est une
 * photographie informative, non une preuve de caisse ni un reçu de versement. */
import {validateCompensatedSummary} from './day-invoice-compensated-summary.jsx';
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const safe=x=>Number.isSafeInteger(x)&&x>=0;
const amount=x=>{if(!Number.isSafeInteger(x))throw Error('Montant invalide.');const n=BigInt(x),abs=n<0n?-n:n;return `${n<0n?'-':''}${abs/1000n},${String(abs%1000n).padStart(3,'0')}`;};
const escape=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cell=x=>{let s=String(x??'');if(/^[\s\u0000-\u001f]*[=+@\-\t\r]/.test(s))s="'"+s;return `"${s.replace(/"/g,'""')}"`;};
function tunisDay(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value))throw Error('Date invalide.');const d=new Date(value);if(!Number.isFinite(d.getTime()))throw Error('Date invalide.');const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);const get=k=>parts.find(p=>p.type===k)?.value;return `${get('year')}-${get('month')}-${get('day')}`;}
function build(summary,commercialId,day,generatedAt){
 validateCompensatedSummary(summary,commercialId,day);
 if(summary.detailsVersion!==1||!Array.isArray(summary.dayInvoicePayments)||!Array.isArray(summary.oldDebtPayments)||!Array.isArray(summary.expenses)||!safe(summary.expenseTotal)||tunisDay(generatedAt)==='')throw Error('Détails de synthèse indisponibles : mettez à jour le serveur.');
 const rows=new Map(summary.rows.map(r=>[r.clientId,r])),seen=new Set(),invoice=new Map(),debt=new Map();
 if(summary.rows.reduce((n,r)=>n+BigInt(r.totalCollected),0n)!==BigInt(summary.totalCollected))throw Error('Total encaissé et lignes clients incohérents.');
 const process=(list,target,creditAllowed)=>{
  if(list.length>20000)throw Error('Trop de paiements pour un export complet.');
  for(const p of list){
   if(!p||!uuid(p.operationId)||seen.has(p.operationId.toLowerCase())||!rows.has(p.clientId)||tunisDay(p.recordedAt)!==day||!safe(p.amount)||!['Espèces','Chèque','Virement',...(creditAllowed?['Crédit']:[])].includes(p.mode)||p.mode==='Crédit'&&p.amount!==0||p.mode!=='Crédit'&&p.amount===0||![p.chequeNumber,p.chequeBank,p.chequeDue].every(x=>typeof x==='string'&&x.length<=100)||p.mode==='Chèque'&&![p.chequeNumber,p.chequeBank,p.chequeDue].every(x=>x.trim())||p.mode!=='Chèque'&&(p.chequeNumber||p.chequeBank||p.chequeDue))throw Error('Paiement de synthèse incohérent.');
   seen.add(p.operationId.toLowerCase());const entry=target.get(p.clientId)??{total:0n,modes:[]};entry.total+=BigInt(p.amount);entry.modes.push(`${p.mode} ${amount(p.amount)}${p.mode==='Chèque'?` (${p.chequeNumber} / ${p.chequeBank} / ${p.chequeDue})`:''}`);target.set(p.clientId,entry);
  }
 };
 process(summary.dayInvoicePayments,invoice,true);process(summary.oldDebtPayments,debt,false);
 for(const r of summary.rows){if((invoice.get(r.clientId)?.total??0n)!==BigInt(r.dayInvoicePaid)||(debt.get(r.clientId)?.total??0n)>BigInt(r.oldDebtPaid))throw Error('Paiements et lignes clients incohérents.');}
 const expenseIds=new Set();let expenses=0n;
 for(const e of summary.expenses){if(!e||!uuid(e.operationId)||expenseIds.has(e.operationId.toLowerCase())||tunisDay(e.createdAt)!==day||typeof e.description!=='string'||!e.description.trim()||e.description.length>200||!safe(e.amount)||e.amount===0)throw Error('Dépense incohérente.');expenseIds.add(e.operationId.toLowerCase());expenses+=BigInt(e.amount);}
 if(expenses!==BigInt(summary.expenseTotal))throw Error('Total des dépenses incohérent.');
 const values=summary.rows.map(r=>[r.clientName,r.sector,amount(r.preInvoiceTotal),amount(r.salesTotal),amount(r.totalClient),amount(r.dayInvoicePaid),(invoice.get(r.clientId)?.modes??[]).join(' / '),amount(r.oldDebtPaid),(debt.get(r.clientId)?.modes??[]).join(' / '),amount(r.totalCollected),amount(r.refund),amount(r.credit),amount(r.theoreticalNet)]);
 const headers=['Client','Secteur','Préétablie DT','Ventes sur place DT','Facture du jour DT','Paiement unique DT','Modes du paiement unique','Ancienne dette réglée DT','Modes dette v6','Encaissé enregistré DT','Remboursement choisi DT','Crédit choisi DT','Encaissé théorique DT'];
 const totals=[['Facturé DT',amount(summary.totalBilled)],['Encaissé enregistré DT',amount(summary.totalCollected)],['Remboursements choisis DT',amount(summary.refund)],['Crédits choisis DT',amount(summary.credit)],['Encaissé théorique DT',amount(summary.theoreticalNet)],['Dépenses reçues DT',amount(summary.expenseTotal)]];
 const note='Synthèse serveur informative : opérations hors ligne absentes ; remboursement choisi non prouvé physiquement et sans mode. Les règlements globaux non qualifiés ne sont pas classés en ancienne dette. Dépenses non déduites. Ce document ne clôture pas la journée.';
 return {headers,values,totals,note,expenses:summary.expenses.map(e=>[e.createdAt,e.description,amount(e.amount)])};
}
export function compensatedSummaryCsv(summary,commercialId,day,generatedAt){
 const d=build(summary,commercialId,day,generatedAt),line=values=>values.map(cell).join(';');
 return '\ufeff'+[line(['Synthèse après compensation',summary.commercial.name,day,generatedAt]),line([d.note]),'',line(d.headers),...d.values.map(line),'',line(['Récapitulatif','DT']),...d.totals.map(line),'',line(['Dépenses reçues','Description','Montant DT']),...d.expenses.map(line)].join('\r\n');
}
export function compensatedSummaryHtml(summary,commercialId,day,generatedAt){
 const d=build(summary,commercialId,day,generatedAt),table=(heads,values)=>`<table><thead><tr>${heads.map(x=>`<th>${escape(x)}</th>`).join('')}</tr></thead><tbody>${values.map(row=>`<tr>${row.map(x=>`<td>${escape(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
 return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Synthèse après compensation</title><style>body{font:12px Arial,sans-serif;color:#17243a}h1{font-size:19px}p{line-height:1.4}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #b7c3ce;padding:5px;text-align:left;overflow-wrap:anywhere}th{background:#edf3f6}@page{size:landscape;margin:12mm}</style></head><body><h1>Synthèse après compensation</h1><p>${escape(summary.commercial.name)} · ${escape(day)} · généré ${escape(generatedAt)}</p><p>${escape(d.note)}</p>${table(d.headers,d.values)}<h2>Récapitulatif</h2>${table(['Libellé','DT'],d.totals)}<h2>Dépenses reçues</h2>${table(['Date UTC','Description','DT'],d.expenses)}</body></html>`;
}
