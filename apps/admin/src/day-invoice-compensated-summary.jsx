import React from 'react';

const integer=n=>Number.isSafeInteger(n),nonnegative=n=>integer(n)&&n>=0;
const money=n=>{const value=BigInt(n),abs=value<0n?-value:value;return `${value<0n?'-':''}${abs/1000n},${String(abs%1000n).padStart(3,'0')} DT`;};
/** Ne pas accepter une synthèse incohérente et ne pas la réutiliser comme
 * preuve de caisse ou comme entrée des anciens exports. */
export function validateCompensatedSummary(data,commercialId,day){
 if(!data||data.version!==1||data.day!==day||data.commercial?.id!==commercialId||typeof data.commercial?.name!=='string'||!['open','closed'].includes(data.closure?.status)||!nonnegative(data.closure?.version)||!Array.isArray(data.rows))throw Error('Synthèse de compensation incohérente.');
 if(![data.totalBilled,data.totalCollected,data.refund,data.credit].every(nonnegative)||!integer(data.theoreticalNet)||BigInt(data.totalCollected)-BigInt(data.refund)!==BigInt(data.theoreticalNet))throw Error('Totaux de compensation incohérents.');
 const ids=new Set();let billed=0n,refund=0n,credit=0n;
 for(const r of data.rows){
  if(!r||typeof r.clientId!=='string'||!r.clientId||ids.has(r.clientId)||typeof r.clientName!=='string'||typeof r.sector!=='string'||![r.preInvoiceTotal,r.salesTotal,r.totalClient,r.dayInvoicePaid,r.oldDebtPaid,r.totalCollected,r.refund,r.credit].every(nonnegative)||!integer(r.theoreticalNet)||BigInt(r.preInvoiceTotal)+BigInt(r.salesTotal)!==BigInt(r.totalClient)||BigInt(r.totalCollected)-BigInt(r.refund)!==BigInt(r.theoreticalNet))throw Error('Ligne de compensation incohérente.');
  ids.add(r.clientId);billed+=BigInt(r.totalClient);refund+=BigInt(r.refund);credit+=BigInt(r.credit);
 }
 if(billed!==BigInt(data.totalBilled)||refund!==BigInt(data.refund)||credit!==BigInt(data.credit))throw Error('Totaux clients incohérents.');
 return data;
}
export function DayInvoiceCompensatedSummary({summary}){
 return <div className="payment-history"><h2>Journal après compensation · lecture seule</h2>
  <p className="notice">Montants reçus par le serveur pour {summary.commercial.name} · {summary.day}. Les opérations encore hors ligne ne sont pas visibles. Le total encaissé peut inclure des règlements globaux ou anciens non attribués aux lignes clients. Les remboursements sont des choix enregistrés : ils ne prouvent ni une remise physique ni un mode de paiement. Cette synthèse ne valide pas la clôture et ne remplace pas les exports.</p>
  <div className="stats"><div className="stat"><span>Factures du jour</span><strong>{money(summary.totalBilled)}</strong></div><div className="stat"><span>Encaissé enregistré</span><strong>{money(summary.totalCollected)}</strong></div><div className="stat"><span>Remboursements choisis</span><strong>{money(summary.refund)}</strong></div><div className="stat"><span>Crédits choisis</span><strong>{money(summary.credit)}</strong></div><div className="stat"><span>Encaissé théorique après remboursements</span><strong>{money(summary.theoreticalNet)}</strong></div></div>
  <div className="table-wrap"><table><thead><tr><th>CLIENT</th><th>PRÉÉTABLIE</th><th>VENTES EN PLUS</th><th>FACTURE DU JOUR</th><th>PAIEMENT UNIQUE</th><th>ANCIENNE DETTE</th><th>REMBOURSEMENT CHOISI</th><th>CRÉDIT CHOISI</th><th>ENCAISSÉ THÉORIQUE</th></tr></thead><tbody>{summary.rows.map(r=><tr key={r.clientId}><td>{r.clientName}<br/><small>{r.sector}</small></td><td>{money(r.preInvoiceTotal)}</td><td>{money(r.salesTotal)}</td><td>{money(r.totalClient)}</td><td>{money(r.dayInvoicePaid)}</td><td>{money(r.oldDebtPaid)}</td><td>{money(r.refund)}</td><td>{money(r.credit)}</td><td>{money(r.theoreticalNet)}</td></tr>)}</tbody></table></div>
 </div>;
}
