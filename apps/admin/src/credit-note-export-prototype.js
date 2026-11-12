/** Export préparatoire du registre validé côté serveur, non branché à l'interface.
 * Les montants sont en millimes, les remboursements ne sont pas des paiements
 * d'ancienne dette ; les avoirs sont datés du jour de leur création. */
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const integer=(x,negative=false)=>Number.isSafeInteger(x)&&(negative||x>=0);
const amount=x=>{if(!integer(x,true))throw Error('Montant invalide.');const n=BigInt(x),v=n<0n?-n:n;return `${n<0n?'-':''}${v/1000n},${String(v%1000n).padStart(3,'0')}`;};
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cell=x=>{let s=String(x??'');if(/^[\s\u0000-\u001f]*[=+@\-\t\r]/.test(s))s="'"+s;return `"${s.replace(/"/g,'""')}"`;};
const date=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x+'T00:00:00Z'))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
const timeDay=x=>{const d=new Date(x);if(!Number.isFinite(d.getTime())||d.toISOString()!==x)throw Error('Date d’avoir invalide.');const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);const part=k=>parts.find(x=>x.type===k)?.value;return `${part('year')}-${part('month')}-${part('day')}`;};
function selected(records,day,commercialId){
 if(!Array.isArray(records)||!date(day)||!uuid(commercialId))throw Error('Sélection invalide.');
 const ids=new Set();
 for(const r of records){
  if(!r||!uuid(r.operationId)||ids.has(r.operationId)||!uuid(r.invoiceId)||!uuid(r.clientId)||!uuid(r.ownerId)||!['sale','preinvoice'].includes(r.kind)||typeof r.clientName!=='string'||!r.clientName.trim()||!date(r.invoiceDay)||!date(r.recordedDay)||timeDay(r.recordedAt)!==r.recordedDay||!r.actor||!['admin','commercial'].includes(r.actor.role)||typeof r.actor.id!=='string'||!r.actor.id.trim()||(r.actor.role==='commercial'&&!uuid(r.actor.id))||!Number.isSafeInteger(r.version)||r.version<1||r.version>=1000000||typeof r.wasDeclared!=='boolean'||![r.invoiceTotal,r.netPaid,r.oldDebtPaid,r.refund,r.retainedCredit].every(x=>integer(x))||!integer(r.balanceDelta,true))throw Error('Historique d’avoirs invalide.');
  if(r.cashAssignment!=null){const a=r.cashAssignment;if(r.actor.role!=='admin'||r.refund<=0||!a||typeof a!=='object'||Object.keys(a).sort().join(',')!=='actorId,assignedAt,commercialId,requestId'||!uuid(a.requestId)||(a.commercialId!==null&&!uuid(a.commercialId))||typeof a.actorId!=='string'||!a.actorId.trim()||a.actorId.length>200||typeof a.assignedAt!=='string'||!Number.isFinite(Date.parse(a.assignedAt))||new Date(a.assignedAt).toISOString()!==a.assignedAt)throw Error('Attribution de remboursement invalide.');}
  ids.add(r.operationId);
  if(BigInt(r.refund)+BigInt(r.retainedCredit)!==BigInt(r.netPaid)||(r.kind==='sale'&&(!r.wasDeclared||r.oldDebtPaid!==0))||(!r.wasDeclared&&(r.netPaid!==0||r.kind!=='preinvoice'))||BigInt(r.balanceDelta)!==(r.wasDeclared?-BigInt(r.invoiceTotal)+BigInt(r.refund):0n))throw Error('Montants d’avoir incohérents.');
 }
 return records.filter(r=>r.recordedDay===day&&r.ownerId===commercialId);
}
function data(records,day,commercialId){
 const rows=selected(records,day,commercialId),sum=key=>{const v=rows.reduce((n,r)=>n+BigInt(r[key]),0n);if(v>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Total trop élevé.');return amount(Number(v));};
 return {rows:rows.map(r=>[r.clientName,r.kind==='sale'?'Vente SLS':'Facture préétablie',r.invoiceId,r.invoiceDay,r.recordedAt,r.actor.role==='admin'?'Administrateur':'Commercial',r.actor.id,amount(r.invoiceTotal),amount(r.netPaid),amount(r.refund),amount(r.retainedCredit),amount(r.oldDebtPaid),amount(r.balanceDelta),r.wasDeclared?'Oui':'Non',r.refund===0?'Sans remboursement':r.actor.role==='commercial'?`Commercial ${r.actor.id}`:!r.cashAssignment?'Non attribuée':r.cashAssignment.commercialId?`Commercial ${r.cashAssignment.commercialId}`:'Caisse administrative',r.cashAssignment?.actorId??'',r.cashAssignment?.assignedAt??'']),count:rows.length,notes:sum('invoiceTotal'),refund:sum('refund'),retained:sum('retainedCredit')};
}
export const creditHeaders=['Client','Origine','Facture','Date facture','Création UTC','Acteur','Identifiant acteur','Avoir DT','Paiement facture DT','Remboursement DT','Crédit client DT','Ancienne dette réglée DT','Variation du solde DT','Facture déclarée','Caisse du remboursement','Attribution par','Attribution UTC'];
/** Appelé avec les seuls avoirs déjà filtrés par commercial et date. */
export function creditJournalExportRows(records,day,commercialId){
 const selectedRecords=selected(records,day,commercialId);
 if(selectedRecords.length!==records.length)throw Error('Avoir hors du périmètre du journal.');
 return data(records,day,commercialId).rows;
}
const explanation='Données fictives reçues au serveur. Avoirs créés à la date sélectionnée, pour les factures du commercial sélectionné ; un autre acteur peut avoir créé l’avoir. Les autres appareils non synchronisés sont exclus. Le règlement d’ancienne dette reste conservé. Une facture préétablie doit aussi être corrigée séparément dans le système principal. Numérotation et fiscalité à valider.';
export function prototypeCreditCsv(records,day,commercialId,commercialName){
 const d=data(records,day,commercialId),rows=[['Historique des avoirs — démonstration'],['Date',day,'Commercial propriétaire',commercialName],['Périmètre',explanation],[],creditHeaders,...d.rows,[],['Nombre d’avoirs',String(d.count)],['Total avoirs DT',d.notes],['Total remboursé DT',d.refund],['Total conservé en crédit DT',d.retained]];
 return '\uFEFF'+rows.map(r=>r.map(cell).join(';')).join('\r\n')+'\r\n';
}
export function prototypeCreditHtml(records,day,commercialId,commercialName){
 const d=data(records,day,commercialId),table=(head,rows)=>`<table><thead><tr>${head.map(v=>`<th>${esc(v)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(v=>`<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
 return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Historique des avoirs</title><style>@page{size:landscape;margin:10mm}body{font:11px Arial}table{border-collapse:collapse;width:100%}th,td{border:1px solid #aaa;padding:4px;text-align:left;overflow-wrap:anywhere}th{background:#e3f2e8}tr{break-inside:avoid}</style></head><body><h1>Historique des avoirs — démonstration</h1><p>${esc(day)} · ${esc(commercialName)}</p><p>${esc(explanation)}</p>${table(creditHeaders,d.rows)}${table(['Indicateur','Valeur'],[['Nombre d’avoirs',d.count],['Total avoirs DT',d.notes],['Total remboursé DT',d.refund],['Total conservé en crédit DT',d.retained]])}</body></html>`;
}
