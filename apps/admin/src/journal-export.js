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
 [j.creditVersion===5?'Total encaissé avant remboursements (DT)':'Total encaissé (DT)',amount(j.totalCollected)]
];

const saleRefundHeaders=['Client','Vente','Version','Date de saisie (UTC)','Remboursement DT'];
export function saleRefundDetails(j){
 if(j.creditVersion===undefined)return null;
 if(j.creditVersion!==5||!Array.isArray(j.saleRefundEvents)||!Number.isSafeInteger(j.saleRefundTotal)||j.saleRefundTotal<0)throw Error('Remboursements de ventes indisponibles.');
 const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
 const seen=new Set();let total=0n;
 const rows=j.saleRefundEvents.map(e=>{
  if(!e||typeof e!=='object'||typeof e.recordedAt!=='string')throw Error('Remboursement de vente incohérent.');
  const d=new Date(e.recordedAt),day=Number.isFinite(d.getTime())?new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).format(d):'';
  if(!uuid(e.operationId)||seen.has(e.operationId)||!uuid(e.saleId)||!uuid(e.clientId)||typeof e.clientName!=='string'||!e.clientName.trim()||!Number.isSafeInteger(e.version)||e.version<2||!Number.isSafeInteger(e.refund)||e.refund<=0||day!==j.day)throw Error('Remboursement de vente incohérent.');
  seen.add(e.operationId);total+=BigInt(e.refund);
  return [e.clientName,e.saleId,String(e.version),d.toISOString(),amount(e.refund)];
 });
 if(total>BigInt(Number.MAX_SAFE_INTEGER)||Number(total)!==j.saleRefundTotal)throw Error('Total des remboursements de ventes incohérent.');
 return {rows,total:amount(j.saleRefundTotal)};
}

export function creditDetails(j){
 if(j.creditVersion===undefined)return null;
 if(j.creditVersion!==5||!Array.isArray(j.creditEvents)||!Array.isArray(j.creditCashEvents)||!Array.isArray(j.unassignedCreditRefundEvents)||!j.commercial?.id)throw new Error('Journal d’avoirs invalide.');
 saleRefundDetails(j);
 if(!Array.isArray(j.rows)||j.rows.some(r=>typeof r.preInvoiceCancelled!=='boolean'||!Number.isSafeInteger(r.cancelledSaleCount)||r.cancelledSaleCount<0||(!r.preInvoiceId&&r.preInvoiceCancelled)))throw new Error('Statut des factures invalide.');
 const rows=creditJournalExportRows(j.creditEvents,j.day,j.commercial.id);
 const seen=new Set(),owned=new Map(j.creditEvents.map(e=>[e.operationId,e]));
 const signature=e=>JSON.stringify([e.kind,e.operationId,e.invoiceId,e.invoiceDay,e.recordedAt,e.recordedDay,e.clientId,e.clientName,e.ownerId,e.actor.role,e.actor.id,e.version,e.invoiceTotal,e.netPaid,e.oldDebtPaid,e.wasDeclared,e.refund,e.retainedCredit,e.balanceDelta]);
 const build=(list,unassigned)=>list.map(e=>{
  if(!e||seen.has(e.operationId)||e.refund<=0||(unassigned?(e.actor?.role!=='admin'||e.ownerId!==j.commercial.id):(e.actor?.role!=='commercial'||e.actor.id!==j.commercial.id)))throw Error('Attribution de remboursement d’avoir incohérente.');
  const row=creditJournalExportRows([e],j.day,e.ownerId)[0];seen.add(e.operationId);
  if(e.ownerId===j.commercial.id&&(!owned.has(e.operationId)||signature(owned.get(e.operationId))!==signature(e)))throw Error('Attribution de remboursement d’avoir incohérente.');
  return row;
 });
 const cashRows=build(j.creditCashEvents,false),unassignedRows=build(j.unassignedCreditRefundEvents,true);
 for(const e of j.creditEvents)if(e.refund>0&&(e.actor.role==='admin'||(e.actor.role==='commercial'&&e.actor.id===j.commercial.id))&&!seen.has(e.operationId))throw Error('Remboursement d’avoir manquant.');
 const sum=(list,key)=>list.reduce((n,e)=>n+BigInt(e[key]),0n);
 const notes=sum(j.creditEvents,'invoiceTotal'),refund=sum(j.creditCashEvents,'refund'),unassigned=sum(j.unassignedCreditRefundEvents,'refund'),retained=sum(j.creditEvents,'retainedCredit');
 const safe=(n)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw new Error('Total trop élevé.');return Number(n);};
 if(!Number.isSafeInteger(j.saleRefundTotal)||j.saleRefundTotal<0)throw new Error('Remboursements de ventes indisponibles.');
 if(j.creditNoteTotal!==safe(notes)||j.creditRefundTotal!==safe(refund)||j.creditRefundUnassignedTotal!==safe(unassigned)||j.creditRetainedTotal!==safe(retained)||j.billedAfterCredits!==safe(BigInt(j.totalBilled)-notes)||j.collectedAfterRefunds!==safe(BigInt(j.totalCollected)-refund-BigInt(j.saleRefundTotal)))throw new Error('Totaux d’avoirs incohérents.');
 return {rows,cashRows,unassignedRows,summary:[['Avoirs des factures du commercial (DT)',amount(j.creditNoteTotal)],['Facturé moins avoirs du jour (DT)',amount(j.billedAfterCredits)],['Remboursements enregistrés par ce commercial (DT)',amount(j.creditRefundTotal)],['Remboursements admin à attribuer (DT)',amount(j.creditRefundUnassignedTotal)],['Crédits clients conservés (DT)',amount(j.creditRetainedTotal)],['Encaissé après remboursements attribués (DT)',amount(j.collectedAfterRefunds)]]};
}
const detailHeaders=(j)=>j.creditVersion===5?[...headers.map(h=>h==='Paiement ventes DT'?'Paiement initial ventes DT':h),'Ventes de cette journée annulées']:headers;
const detailColumns=(j,r)=>j.creditVersion===5?[...columns(r).slice(0,-1),r.preInvoiceCancelled?'Annulée par avoir':columns(r).at(-1),String(r.cancelledSaleCount)]:columns(r);
const state = j => `${j.closure.status==='closed'?'Clôturée':'Ouverte'} · version ${j.closure.version}`;
const note = j => 'Données identifiées reçues par le serveur pour ce commercial et cette date uniquement. Les opérations non synchronisées, les autres commerciaux et les anciennes opérations non attribuées ne sont pas inclus dans le journal. Les paiements sur anciennes factures non attribuées sont indiqués séparément. Le total facturé n’est pas un chiffre d’affaires consolidé. '+(j.creditVersion===5?'Les factures affichent leur dernière version reçue ; les paiements de vente affichent le montant initial et les remboursements de modification sont indiqués au jour et commercial de leur enregistrement.':'Les ventes affichent leur dernière version reçue ; cet export n’est pas un historique des corrections.');
export function journalServerCsv(j, generatedAt) {
 const credits=creditDetails(j),saleRefunds=saleRefundDetails(j);
 const rows=[['Journal de tournée identifié — synthèse serveur (données fictives)'],['Date',j.day,'Commercial',j.commercial.name],['État',state(j),'Exporté le (UTC)',generatedAt],['Périmètre',note(j)],[],detailHeaders(j),...j.rows.map(r=>detailColumns(j,r)),[],...summary(j),[],['Paiements sur anciennes factures non attribuées'],['Client','Paiement facture DT','Ancienne dette réglée DT'],...j.inheritedJournalPayments.map(r=>[r.clientName,amount(r.prePaid),amount(r.oldDebtPaid)])];
 if(saleRefunds)rows.push([],['Remboursements de modifications — sorties du jour'],saleRefundHeaders,...saleRefunds.rows,['Total remboursements de modifications DT',saleRefunds.total],['Note','Les paiements initiaux et les remboursements sont attribués à leur journée et à leur commercial. Le total après remboursements les déduit une seule fois. Leur enregistrement ne prouve pas le versement physique.']);
 if(credits)rows.push([],['Avoirs des factures du commercial'],creditHeaders,...credits.rows,[],['Remboursements enregistrés par ce commercial'],creditHeaders,...credits.cashRows,[],['Remboursements enregistrés par un administrateur — caisse à vérifier'],creditHeaders,...credits.unassignedRows,[],...credits.summary,['Note','Les avoirs restent attribués au propriétaire de la facture ; les remboursements enregistrés par un commercial sont déduits de sa caisse. Les remboursements enregistrés par un administrateur ne sont pas attribués automatiquement et ne sont pas déduits : caisse à vérifier. Le versement physique reste à vérifier. Une préétablie doit être corrigée dans le système principal.']);
 return '\uFEFF'+rows.map(row=>row.map(csvCell).join(';')).join('\r\n')+'\r\n';
}
export function journalServerHtml(j, generatedAt) {
 const credits=creditDetails(j),saleRefunds=saleRefundDetails(j);
 const table=(head,rows)=>`<table><thead><tr>${head.map(x=>`<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(row=>`<tr>${row.map(x=>`<td>${esc(x)}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="${head.length}">Aucune donnée reçue.</td></tr>`}</tbody></table>`;
 return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Journal de tournée ${esc(j.day)}</title><style>@page{size:landscape;margin:12mm}body{font:11px Arial,sans-serif;color:#193c35}h1{font-size:21px}p{line-height:1.4}table{border-collapse:collapse;width:100%;margin:12px 0;table-layout:auto}th,td{border:1px solid #a9beb2;padding:5px;text-align:left;overflow-wrap:anywhere}th{background:#e3f2e8}thead{display:table-header-group}tr{break-inside:avoid}.note{padding:10px;background:#fff7e3}</style></head><body><h1>Journal de tournée identifié — synthèse serveur</h1><p>Données fictives · Date : ${esc(j.day)} · Commercial : ${esc(j.commercial.name)} · ${esc(state(j))} · Exporté le ${esc(generatedAt)} (UTC)</p><p class="note">${esc(note(j))}</p>${table(detailHeaders(j),j.rows.map(r=>detailColumns(j,r)))}<h2>Totaux</h2>${table(['Indicateur','Valeur'],summary(j))}<h2>Paiements sur anciennes factures non attribuées</h2>${table(['Client','Paiement facture DT','Ancienne dette réglée DT'],j.inheritedJournalPayments.map(r=>[r.clientName,amount(r.prePaid),amount(r.oldDebtPaid)]))}${saleRefunds?`<h2>Remboursements de modifications</h2><p>Sorties enregistrées ce jour ; elles sont déduites une seule fois dans le total après remboursements. Leur enregistrement ne prouve pas le versement physique. Total : ${esc(saleRefunds.total)} DT.</p>${table(saleRefundHeaders,saleRefunds.rows)}`:''}${credits?`<h2>Avoirs créés ce jour — distincts des factures d’origine</h2><p>Les avoirs restent attribués au propriétaire. Les remboursements d’un commercial sont déduits de sa caisse. Les remboursements enregistrés par un administrateur ne sont pas attribués ni déduits : caisse à vérifier. Le versement physique reste à vérifier. Une préétablie doit être corrigée dans le système principal.</p>${table(creditHeaders,credits.rows)}<h2>Remboursements enregistrés par ce commercial</h2>${table(creditHeaders,credits.cashRows)}<h2>Remboursements admin — caisse à vérifier</h2>${table(creditHeaders,credits.unassignedRows)}${table(['Indicateur','Valeur'],credits.summary)}`:''}<p>Règlements globaux : montant total uniquement ; détail par client non disponible dans cette vue.</p></body></html>`;
}
