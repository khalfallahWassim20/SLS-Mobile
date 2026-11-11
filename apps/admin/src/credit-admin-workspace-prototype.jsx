/** Assemblage expérimental non monté dans main.jsx. Les actions commerciales,
 * la synchronisation et le serveur doivent migrer ensemble avant activation. */
import React,{useEffect,useRef,useState} from 'react';
import {CreditAdminReviewView} from './credit-admin-review-view.jsx';
import {CreditJournalView} from './credit-journal-view.jsx';
import {loadCreditAdminSnapshot,loadCreditAdminSaleHistory,loadCreditAdminJournal,exportCreditAdminJournal} from './credit-admin-workspace-prototype.js';
const money=x=>{const n=BigInt(x),a=n<0n?-n:n;return `${n<0n?'-':''}${a/1000n},${String(a%1000n).padStart(3,'0')} DT`;};
/** request doit authentifier chaque requête ; onExport reçoit le contenu CSV
 * ou HTML pour impression PDF. Aucun mot de passe n'est stocké ici. */
export function CreditAdminWorkspacePrototype({request,commercials,initialDay,onExport}){
 const [snapshot,setSnapshot]=useState(null),[reviewClient,setReviewClient]=useState(null),[commercialId,setCommercialId]=useState(''),[day,setDay]=useState(initialDay),[journal,setJournal]=useState(null),[history,setHistory]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const generation=useRef(0),mounted=useRef(false),running=useRef(false),reopenAttempt=useRef(null);
 const load=async()=>{const seq=++generation.current;setSnapshot(null);setJournal(null);setHistory(null);setError('');try{const result=await loadCreditAdminSnapshot(request);if(mounted.current&&seq===generation.current)setSnapshot(result);}catch(e){if(mounted.current&&seq===generation.current)setError(e instanceof Error?e.message:'Instantané indisponible.');}};
 useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;generation.current++;};},[request]);
 const showHistory=async(sale)=>{if(running.current)return;running.current=true;const seq=++generation.current;setBusy(true);setHistory(null);setError('');try{const result=await loadCreditAdminSaleHistory(request,sale);if(mounted.current&&seq===generation.current)setHistory(result);}catch(e){if(mounted.current&&seq===generation.current)setError(e instanceof Error?e.message:'Historique indisponible.');}finally{running.current=false;if(mounted.current)setBusy(false);}};
 const showJournal=async()=>{if(running.current)return;running.current=true;const seq=++generation.current;setBusy(true);setJournal(null);setError('');try{const result=await loadCreditAdminJournal(request,commercialId,day);if(mounted.current&&seq===generation.current)setJournal(result);}catch(e){if(mounted.current&&seq===generation.current)setError(e instanceof Error?e.message:'Journal indisponible.');}finally{running.current=false;if(mounted.current)setBusy(false);}};
 const reopen=async()=>{if(!journal||journal.closure.status!=='closed'||running.current)return;
  if(!window.confirm('Rouvrir cette journée ? Les écritures pourront reprendre pour ce commercial.'))return;
  if(typeof globalThis.crypto?.randomUUID!=='function'){setError('Identifiant sécurisé indisponible : utilisez HTTPS ou localhost.');return;}
  const commercial=commercialId,date=day,version=journal.closure.version;
  let attempt=reopenAttempt.current;
  if(!attempt||attempt.commercialId!==commercial||attempt.day!==date||attempt.expectedVersion!==version)attempt={commercialId:commercial,day:date,expectedVersion:version,requestId:globalThis.crypto.randomUUID()};
  reopenAttempt.current=attempt;running.current=true;const seq=++generation.current;setBusy(true);setError('');
  try{const result=await request(`identified-tour-actions/${encodeURIComponent(commercial)}/reopen`,{method:'POST',headers:{'X-SLS-Reference-Version':'5'},body:JSON.stringify({requestId:attempt.requestId,day:date,expectedVersion:version})});
   if(!result||!['received','duplicate'].includes(result.status)||result.requestId!==attempt.requestId||result.commercialId!==commercial||result.day!==date||result.action!=='reopen'||result.version!==version+1)throw Error('Accusé de réouverture invalide : réessayez avec la même demande.');
   const refreshed=await loadCreditAdminJournal(request,commercial,date);if(refreshed.closure.status!=='open'||refreshed.closure.version<result.version)throw Error('État de réouverture non confirmé.');
   if(mounted.current&&seq===generation.current){setJournal(refreshed);reopenAttempt.current=null;}
  }catch(e){if(mounted.current&&seq===generation.current)setError(e instanceof Error?e.message:'Réouverture impossible.');}finally{running.current=false;if(mounted.current)setBusy(false);}
 };
 const exportJournal=async(format)=>{if(!journal||running.current)return;
  const printWindow=format==='pdf'?window.open('','_blank'):null;
  if(format==='pdf'&&!printWindow){setError('Autorisez les fenêtres contextuelles pour préparer le PDF.');return;}
  if(printWindow)printWindow.document.body.textContent='Préparation du journal…';
  running.current=true;const seq=++generation.current;setBusy(true);setError('');try{const result=await exportCreditAdminJournal(request,commercialId,day,format);if(mounted.current&&seq===generation.current){setJournal(result.journal);await onExport(format,result,printWindow);}else if(printWindow&&!printWindow.closed)printWindow.close();}catch(e){if(printWindow&&!printWindow.closed)printWindow.close();if(mounted.current&&seq===generation.current){setJournal(null);setError(e instanceof Error?e.message:'Export impossible.');}}finally{running.current=false;if(mounted.current)setBusy(false);}};
 const change=fn=>value=>{generation.current++;setJournal(null);setError('');fn(value);};
 return <div>
  <section className="panel"><h2>Espace administrateur · avoirs v5</h2><p className="notice">Seules les données reçues du serveur sont affichées. Les opérations hors ligne d’un téléphone ne sont pas encore visibles. Les préétablies doivent aussi être corrigées dans le système principal.</p>
   {error&&<p className="error" role="alert">{error}</p>}
   <button disabled={busy} onClick={()=>void load()}>Actualiser soldes et ventes</button>
   {!snapshot?<p>Instantané indisponible ou en cours de chargement.</p>:<><h3>Soldes clients</h3><div className="table-wrap"><table><thead><tr><th>Client</th><th>Solde</th><th>Limite</th><th>Statut</th><th/></tr></thead><tbody>{snapshot.balances.map(c=><tr key={c.id}><td>{c.name}</td><td>{money(c.balance)}</td><td>{c.creditLimit==='0'?'Non définie':money(c.creditLimit)}</td><td>{c.active?'Actif':'Inactif'}</td><td><button disabled={busy} onClick={()=>setReviewClient(c.id)}>Préparer un avoir</button></td></tr>)}</tbody></table></div>
    <h3>Ventes reçues</h3><div className="table-wrap"><table><thead><tr><th>Client</th><th>Facture d’origine</th><th>Payé net</th><th>État</th><th>Historique</th></tr></thead><tbody>{snapshot.sales.map(s=><tr key={s.saleId}><td>{s.sale.clientName}</td><td>{money(s.sale.total)}</td><td>{money(s.sale.paid)}</td><td>{s.cancelled?'Annulée par avoir':'Active'}</td><td><button disabled={busy} onClick={()=>void showHistory(s)}>Voir les versions</button></td></tr>)}</tbody></table></div></>}
  </section>
  {history&&<section className="panel"><h2>Historique de la vente</h2><button onClick={()=>setHistory(null)}>Fermer</button>{history.truncated&&<p>Seules les 200 dernières versions sont affichées.</p>}{history.cancelled&&<p>Facture annulée : remboursement {money(history.creditNote.refund)} · crédit conservé {money(history.creditNote.retainedCredit)}.</p>}{history.versions.map(v=><div key={v.operationId}><h3>Version {v.version}</h3><p>Total : {money(v.sale.total)} · payé net : {money(v.sale.paid)} · remboursement de modification : {money(v.refund)}</p><p>Commercial : {v.commercialName||'Non attribué'} · modification : {v.recordedAt||'Non disponible'}</p></div>)}</section>}
  {reviewClient&&<CreditAdminReviewView key={reviewClient} clientId={reviewClient} request={request} onCancel={()=>setReviewClient(null)} onDone={()=>{setReviewClient(null);void load();}}/>}
  <section className="panel"><h2>Journal par commercial et date</h2><div className="filters"><label>Commercial<select value={commercialId} onChange={e=>change(setCommercialId)(e.target.value)}><option value="">Sélectionner</option>{commercials.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Date<input type="date" value={day} onChange={e=>change(setDay)(e.target.value)}/></label><button disabled={busy||!commercialId||!day} onClick={()=>void showJournal()}>Afficher</button></div>
   {journal&&<><p>Facturé brut : {money(journal.totalBilled)} · Encaissé brut : {money(journal.totalCollected)}</p><div className="table-wrap"><table><thead><tr><th>Client</th><th>Préétablie</th><th>Ventes supplémentaires</th><th>Total client</th><th>Ancienne dette réglée</th></tr></thead><tbody>{journal.rows.map(row=><tr key={row.clientId}><td>{row.clientName}</td><td>{money(row.preInvoiceTotal)}{row.preInvoiceCancelled?' · annulée':''}</td><td>{money(row.tourTotal)}</td><td>{money(row.totalClient)}</td><td>{money(row.oldDebtPaid)}</td></tr>)}</tbody></table></div><CreditJournalView journal={journal}/><div className="actions">{journal.closure.status==='closed'&&<button disabled={busy} onClick={()=>void reopen()}>Rouvrir la journée</button>}<button disabled={busy} onClick={()=>void exportJournal('csv')}>Exporter CSV</button><button disabled={busy} onClick={()=>void exportJournal('pdf')}>Imprimer / PDF</button></div></>}
  </section>
 </div>;
}
