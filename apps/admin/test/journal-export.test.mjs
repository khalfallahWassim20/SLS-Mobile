import {test} from 'node:test';
import assert from 'node:assert/strict';
import {journalServerCsv,journalServerHtml} from '../src/journal-export.js';
const day={day:'2026-11-08',commercial:{name:'<Nom>'},closure:{status:'closed',version:1},clientCount:1,totalBilled:850000,journalCollected:650000,inheritedJournalTotal:20000,globalSettlementTotal:10000,totalCollected:680000,rows:[{clientName:'=2+3',sector:'Nord;"A"',preInvoiceTotal:600000,tourTotal:250000,totalClient:850000,preInvoicePaid:250000,oldDebtPaid:400000,tourPaid:0,totalCollected:650000,preInvoiceId:'p',declared:true}],inheritedJournalPayments:[{clientName:'Ancien',prePaid:10000,oldDebtPaid:10000}]};
test('export serveur : chiffres séparés, formules et caractères spéciaux',()=>{
 const csv=journalServerCsv(day,'2026-11-08T12:00:00Z');assert.ok(csv.startsWith('\uFEFF'));assert.match(csv,/850,000/);assert.match(csv,/600,000/);assert.match(csv,/250,000/);assert.match(csv,/680,000/);assert.match(csv,/"'=2\+3"/);assert.match(csv,/"Nord;""A"""/);assert.match(csv,/Ancien/);
 const html=journalServerHtml(day,'2026-11-08T12:00:00Z');assert.match(html,/&lt;Nom&gt;/);assert.doesNotMatch(html,/<Nom>/);assert.match(html,/850,000/);assert.match(html,/Clôturée/);assert.match(html,/non synchronisées/);
});
test('journal vide',()=>{const empty={...day,rows:[],inheritedJournalPayments:[],clientCount:0};assert.match(journalServerHtml(empty,'maintenant'),/Aucune donnée reçue/);assert.match(journalServerCsv(empty,'maintenant'),/Clients du journal/);});
test('journal serveur avec avoir : facture, ancienne dette et mouvements restent distincts',async()=>{
 const {randomUUID}=await import('node:crypto'),owner=randomUUID();
 const entry={kind:'preinvoice',operationId:randomUUID(),invoiceId:randomUUID(),invoiceDay:'2026-11-08',recordedAt:'2026-11-08T12:00:00.000Z',recordedDay:'2026-11-08',clientId:randomUUID(),clientName:'=Fictif',ownerId:owner,actor:{id:'admin',role:'admin'},version:2,invoiceTotal:600000,netPaid:250000,oldDebtPaid:400000,wasDeclared:true,refund:0,retainedCredit:250000,balanceDelta:-600000};
 const report={...day,rows:day.rows.map(r=>({...r,preInvoiceCancelled:true,cancelledSaleCount:2})),commercial:{id:owner,name:'<Commercial>'},creditVersion:5,saleRefundEvents:[],saleRefundTotal:0,creditEvents:[entry],creditCashEvents:[],unassignedCreditRefundEvents:[],creditRefundUnassignedTotal:0,creditNoteTotal:600000,creditRefundTotal:0,creditRetainedTotal:250000,billedAfterCredits:250000,collectedAfterRefunds:680000};
 const csv=journalServerCsv(report,'2026-11-08T12:00:00Z'),html=journalServerHtml(report,'2026-11-08T12:00:00Z');
 assert.match(csv,/Annulée par avoir/);assert.match(csv,/Ventes de cette journée annulées/);assert.match(csv,/Avoirs des factures du commercial/);assert.match(csv,/Facturé moins avoirs du jour/);assert.match(csv,/400,000/);assert.match(csv,/250,000/);assert.match(csv,/'=Fictif/);
 assert.match(html,/système principal/);assert.match(html,/&lt;Commercial&gt;/);assert.match(html,/Avoirs créés ce jour/);
 assert.throws(()=>journalServerCsv({...report,billedAfterCredits:1},'maintenant'),/incohérents/);
 assert.throws(()=>journalServerCsv({...report,creditEvents:[{...entry,ownerId:randomUUID()}]},'maintenant'),/périmètre/);
 assert.throws(()=>journalServerHtml({...report,creditEvents:undefined},'maintenant'),/invalide/);
 assert.throws(()=>journalServerCsv({...report,rows:[{...report.rows[0],cancelledSaleCount:-1}]},'maintenant'),/Statut/);
});


test('remboursements de modification affichés sans double déduction et vérifiés dans les exports',async()=>{
 const {randomUUID}=await import('node:crypto'),owner=randomUUID(),clientId=randomUUID();
 const event={operationId:randomUUID(),saleId:randomUUID(),clientId,clientName:'<Fictif>',version:2,recordedAt:'2026-11-08T10:00:00.000Z',refund:38100};
 const report={...day,commercial:{id:owner,name:'Fictif'},rows:day.rows.map(r=>({...r,clientId,preInvoiceCancelled:false,cancelledSaleCount:0})),creditVersion:5,saleRefundEvents:[event],saleRefundTotal:38100,creditEvents:[],creditCashEvents:[],unassignedCreditRefundEvents:[],creditRefundUnassignedTotal:0,creditNoteTotal:0,creditRefundTotal:0,creditRetainedTotal:0,billedAfterCredits:850000,collectedAfterRefunds:641900};
 const csv=journalServerCsv(report,'maintenant'),html=journalServerHtml(report,'maintenant');
 assert.match(csv,/38,100/);assert.match(csv,/déduit une seule fois/);assert.match(csv,/680,000/);assert.match(html,/&lt;Fictif&gt;/);assert.match(html,/38,100/);
 assert.throws(()=>journalServerCsv({...report,saleRefundTotal:1},'maintenant'),/incohérent/);
 assert.throws(()=>journalServerCsv({...report,saleRefundEvents:[event,event]},'maintenant'),/incohérent/);
 assert.throws(()=>journalServerHtml({...report,saleRefundEvents:[{...event,recordedAt:'2026-11-09T10:00:00.000Z'}]},'maintenant'),/incohérent/);
 assert.throws(()=>journalServerCsv({...report,saleRefundEvents:undefined},'maintenant'),/indisponibles/);
});


test('remboursement par un autre commercial : export sans vente locale ni double décompte',async()=>{
 const {randomUUID}=await import('node:crypto'),owner=randomUUID();
 const entry={operationId:randomUUID(),saleId:randomUUID(),clientId:randomUUID(),clientName:'Client fictif',version:2,recordedAt:'2026-11-09T10:00:00.000Z',refund:38100};
 const j={...day,day:'2026-11-09',commercial:{id:owner,name:'Commercial B'},rows:[],clientCount:0,totalBilled:0,journalCollected:0,inheritedJournalTotal:0,globalSettlementTotal:0,totalCollected:0,inheritedJournalPayments:[],creditVersion:5,creditEvents:[],creditCashEvents:[],unassignedCreditRefundEvents:[],creditRefundUnassignedTotal:0,creditNoteTotal:0,creditRefundTotal:0,creditRetainedTotal:0,billedAfterCredits:0,collectedAfterRefunds:-38100,saleRefundEvents:[entry],saleRefundTotal:38100};
 const csv=journalServerCsv(j,'maintenant'),html=journalServerHtml(j,'maintenant');assert.match(csv,/38,100/);assert.match(csv,/-38,100/);assert.match(html,/-38,100/);assert.match(html,/sorties enregistrées ce jour/i);
 assert.throws(()=>journalServerCsv({...j,collectedAfterRefunds:0},'maintenant'),/incohérents/);
});

test('avoirs intercommerciaux : sortie imputée à l’auteur, admin non attribué, contrôles stricts',async()=>{
 const {randomUUID}=await import('node:crypto'),owner=randomUUID(),actor=randomUUID(),clientId=randomUUID();
 const base={...day,commercial:{id:actor,name:'Commercial B'},rows:[],clientCount:0,totalBilled:0,journalCollected:0,inheritedJournalTotal:0,globalSettlementTotal:0,totalCollected:0,inheritedJournalPayments:[],creditVersion:5,saleRefundEvents:[],saleRefundTotal:0};
 const note={kind:'sale',operationId:randomUUID(),invoiceId:randomUUID(),invoiceDay:'2026-11-07',recordedAt:'2026-11-08T10:00:00.000Z',recordedDay:'2026-11-08',clientId,clientName:'Client fictif',ownerId:owner,actor:{id:actor,role:'commercial'},version:1,invoiceTotal:119000,netPaid:50000,oldDebtPaid:0,wasDeclared:true,refund:50000,retainedCredit:0,balanceDelta:-69000};
 const report={...base,creditEvents:[],creditCashEvents:[note],unassignedCreditRefundEvents:[],creditNoteTotal:0,creditRefundTotal:50000,creditRefundUnassignedTotal:0,creditRetainedTotal:0,billedAfterCredits:0,collectedAfterRefunds:-50000};
 const csv=journalServerCsv(report,'maintenant'),html=journalServerHtml(report,'maintenant');assert.match(csv,/-50,000/);assert.match(csv,/Remboursements enregistrés par ce commercial/);assert.match(html,/50,000/);
 assert.throws(()=>journalServerCsv({...report,creditCashEvents:[note,note]},'maintenant'),/incohérente/);
 assert.throws(()=>journalServerCsv({...report,creditCashEvents:[{...note,actor:{...note.actor,id:randomUUID()}}]},'maintenant'),/incohérente/);
 assert.throws(()=>journalServerCsv({...report,creditCashEvents:[],creditRefundTotal:50000},'maintenant'),/incohérents/);
 const adminNote={...note,ownerId:actor,actor:{id:'admin',role:'admin'}};
 const unassigned={...base,creditEvents:[adminNote],creditCashEvents:[],unassignedCreditRefundEvents:[adminNote],creditNoteTotal:119000,creditRefundTotal:0,creditRefundUnassignedTotal:50000,creditRetainedTotal:0,billedAfterCredits:-119000,collectedAfterRefunds:0};
 assert.match(journalServerCsv(unassigned,'maintenant'),/caisse à vérifier/);
 assert.throws(()=>journalServerCsv({...unassigned,unassignedCreditRefundEvents:[],creditRefundUnassignedTotal:0},'maintenant'),/manquant/);
 assert.throws(()=>journalServerCsv({...unassigned,unassignedCreditRefundEvents:[{...adminNote,refund:10000,retainedCredit:40000,balanceDelta:-109000}]},'maintenant'),/incohérente/);
});
