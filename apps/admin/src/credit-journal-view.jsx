import React from 'react';
import {creditDetails,saleRefundDetails} from './journal-export.js';
import {creditHeaders} from './credit-note-export-prototype.js';

/** Présentation v5 uniquement : les routes de production ne fournissent pas
 * encore ce format. Les montants bruts restent visibles séparément. */
export function CreditJournalView({journal}) {
 const details=creditDetails(journal),refunds=saleRefundDetails(journal);
 if(!details)return null;
 return <section className="payment-history">
  <h2>Remboursements de modifications de vente</h2>
  <p className="notice">Ces sorties sont attribuées au commercial et au jour de la modification, puis déduites une seule fois du total après remboursements. Leur enregistrement ne prouve pas le versement physique.</p>
  <p>Total enregistré : <strong>{refunds.total} DT</strong></p>
  <div className="table-wrap"><table><thead><tr>{['Client','Vente','Version','Date UTC','Remboursement DT'].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{refunds.rows.map((row,i)=><tr key={journal.saleRefundEvents[i].operationId}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody></table>{!refunds.rows.length&&<div className="empty">Aucun remboursement de modification reçu pour cette journée.</div>}</div>
  <h2>Avoirs créés ce jour</h2>
  <p className="notice">Les ventes affichent leurs paiements initiaux ; les remboursements de modification et les avoirs sont distincts. Un avoir peut concerner une facture d’un autre jour : les montants après avoirs peuvent donc être négatifs et ne représentent pas un chiffre d’affaires consolidé. Les avoirs sont attribués au commercial propriétaire de la facture, même s’ils sont créés par un autre acteur : vérifiez séparément la caisse du remboursement. Les règlements d’ancienne dette sont conservés. Une facture préétablie doit aussi être corrigée dans le système principal.</p>
  <div className="kpis">{details.summary.map(([label,value])=><div className="kpi" key={label}><span>{label}</span><strong>{value} DT</strong></div>)}</div>
  <div className="table-wrap"><table><thead><tr>{creditHeaders.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{details.rows.map((row,i)=><tr key={journal.creditEvents[i].operationId}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody></table>{!details.rows.length&&<div className="empty">Aucun avoir reçu pour ce commercial et cette date.</div>}</div>
 </section>;
}
