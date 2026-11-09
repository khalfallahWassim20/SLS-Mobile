import {creditHeaders,creditJournalExportRows} from './credit-note-export-prototype.js';
/** Exports du seul instantané identifié reçu du serveur, en millimes. */
const amount = value => {
 if (!Number.isSafeInteger(value)) throw new Error('Montant du journal invalide.');
 const n=BigInt(value), abs=n<0n?-n:n;
 return `${n<0n?'-':''}${abs/1000n},${String(abs%1000n).padStart(3,'0')}`;
};
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const csvCell = value => {
 let s=String(value ?? '');
 // Les champs sont traités comme du texte par certains tableurs, y compris après espaces.
 if (/^[\s\u0000-\u001f]*[=+@\-\t\r]/.test(s)) s="'"+s;
 return `"${s.replace(/"/g,'""')}"`;
};
const headers=['Client','Secteur','Facture préétablie DT','Ventes supplémentaires DT','Total client DT','Paiement facture DT','Ancienne dette réglée DT','Paiement ventes DT','Encaissé journal DT','Statut préétablie'];
const columns = r => [r.clientName,r.sector || 'Non renseigné',amount(r.preInvoiceTotal),amount(r.tourTotal),amount(r.totalClient),amount(r.preInvoicePaid),amount(r.oldDebtPaid),amount(r.tourPaid),amount(r.totalCollected),r.preInvoiceId ? (r.declared?'Traitée':'Non traitée') : 'Aucune'];
const summary = j => [
 ['Clients du journal',String(j.clientCount)],
 ['Total facturé du journal (DT)',amount(j.totalBilled)],
 ['Encaissé journal (DT)',amount(j.journalCollected)],
 ['Paiements sur anciennes factures non attribuées (DT)',amount(j.inheritedJournalTotal)],
 ['Règlements globaux (DT)',amount(j.globalSettlementTotal)],
 ['Total encaissé (DT)',amount(j.totalCollected)]
];
function creditDetails(j){
 if(j.creditVersion===undefined)return null;
 if(j.creditVersion!==5||!Array.isArray(j.creditEvents)||!j.commercial?.id)throw new Error('Journal d’avoirs invalide.');
 const rows=creditJournalExportRows(j.creditEvents,j.day,j.commercial.id);
 const sum=key=>j.creditEvents.reduce((n,e)=>n+BigInt(e[key]),0n);
 const notes=sum('invoiceTotal'),refund=sum('refund'),retained=sum('retainedCredit');
 const safe=(n)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw new Error('Total trop élevé.');return Number(n);};
 if(j.creditNoteTotal!==safe(notes)||j.creditRefundTotal!==safe(refund)||j.creditRetainedTotal!==safe(retained)||j.billedAfterCredits!==safe(BigInt(j.totalBilled)-notes)||j.collectedAfterRefunds!==safe(BigInt(j.totalCollected)-refund))throw new Error('Totaux d’avoirs incohérents.');
 return {rows,summary:[['Avoirs créés ce jour (DT)',amount(j.creditNoteTotal)],['Facturé moins avoirs du jour (DT)',amount(j.billedAfterCredits)],['Remboursements des avoirs (DT)',amount(j.creditRefundTotal)],['Crédits clients conservés (DT)',amount(j.creditRetainedTotal)],['Encaissé moins remboursements (DT)',amount(j.collectedAfterRefunds)]]};
}
const state = j => `${j.closure.status==='closed'?'Clôturée':'Ouverte'} · version ${j.closure.version}`;
const note = 'Données identifiées reçues par le serveur pour ce commercial et cette date uniquement. Les opérations non synchronisées, les autres commerciaux et les anciennes opérations non attribuées ne sont pas inclus dans le journal. Les paiements sur anciennes factures non attribuées sont indiqués séparément. Le total facturé n’est pas un chiffre d’affaires consolidé. Les ventes sont présentées à leur dernière version reçue ; cet export n’est pas un historique des corrections.';
export function journalServerCsv(j, generatedAt) {
 const credits=creditDetails(j);
 const rows=[['Journal de tournée identifié — synthèse serveur (données fictives)'],['Date',j.day,'Commercial',j.commercial.name],['État',state(j),'Exporté le (UTC)',generatedAt],['Périmètre',note],[],headers,...j.rows.map(columns),[],...summary(j),[],['Paiements sur anciennes factures non attribuées'],['Client','Paiement facture DT','Ancienne dette réglée DT'],...j.inheritedJournalPayments.map(r=>[r.clientName,amount(r.prePaid),amount(r.oldDebtPaid)])];
 if(credits)rows.push([],['Avoirs créés ce jour — distincts des factures d’origine'],creditHeaders,...credits.rows,[],...credits.summary,['Note','Le règlement d’ancienne dette reste conservé. Les avoirs sont datés de leur création. Une préétablie doit être corrigée séparément dans le système principal.']);
 return '\uFEFF'+rows.map(row=>row.map(csvCell).join(';')).join('\r\n')+'\r\n';
}
export function journalServerHtml(j, generatedAt) {
 const credits=creditDetails(j);
 const table=(head,rows)=>`<table><thead><tr>${head.map(x=>`<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(row=>`<tr>${row.map(x=>`<td>${esc(x)}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="${head.length}">Aucune donnée reçue.</td></tr>`}</tbody></table>`;
 return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Journal de tournée ${esc(j.day)}</title><style>@page{size:landscape;margin:12mm}body{font:11px Arial,sans-serif;color:#193c35}h1{font-size:21px}p{line-height:1.4}table{border-collapse:collapse;width:100%;margin:12px 0;table-layout:auto}th,td{border:1px solid #a9beb2;padding:5px;text-align:left;overflow-wrap:anywhere}th{background:#e3f2e8}thead{display:table-header-group}tr{break-inside:avoid}.note{padding:10px;background:#fff7e3}</style></head><body><h1>Journal de tournée identifié — synthèse serveur</h1><p>Données fictives · Date : ${esc(j.day)} · Commercial : ${esc(j.commercial.name)} · ${esc(state(j))} · Exporté le ${esc(generatedAt)} (UTC)</p><p class="note">${esc(note)}</p>${table(headers,j.rows.map(columns))}<h2>Totaux</h2>${table(['Indicateur','Valeur'],summary(j))}<h2>Paiements sur anciennes factures non attribuées</h2>${table(['Client','Paiement facture DT','Ancienne dette réglée DT'],j.inheritedJournalPayments.map(r=>[r.clientName,amount(r.prePaid),amount(r.oldDebtPaid)]))}${credits?`<h2>Avoirs créés ce jour — distincts des factures d’origine</h2><p>Le règlement d’ancienne dette reste conservé. Une préétablie doit être corrigée séparément dans le système principal.</p>${table(creditHeaders,credits.rows)}${table(['Indicateur','Valeur'],credits.summary)}`:''}<p>Règlements globaux : montant total uniquement ; détail par client non disponible dans cette vue.</p></body></html>`;
}
