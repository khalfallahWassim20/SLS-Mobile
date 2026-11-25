/** Audit en lecture seule des avoirs enregistrés : chaque événement est recalculé
 * par les règles du domaine et rapproché de ses mouvements de solde. Fonction
 * pure ; elle ne corrige rien et ne remplace ni le journal ni la caisse. */
import {prepareFullCreditNote,type CreditNoteEvent} from './credit-note-command.ts';
import {canonicalJson} from './canonical-json.ts';
export type AuditedMovement={operationId:string;kind:string;delta:string|number|bigint};
export type CreditNoteAuditIssue={operationId:string|null;invoiceId:string|null;code:string;detail:string};
const big=(v:string|number|bigint)=>{try{return BigInt(v);}catch{return null;}};
export function auditCreditNotes(events:CreditNoteEvent[],movements:AuditedMovement[]):{checked:number;issues:CreditNoteAuditIssue[]}{
 const issues:CreditNoteAuditIssue[]=[];
 const add=(e:{command?:{operationId?:string;invoiceId?:string}}|null,operationId:string|null,code:string,detail:string)=>issues.push({operationId:operationId??e?.command?.operationId??null,invoiceId:e?.command?.invoiceId??null,code,detail});
 const byOperation=new Map<string,AuditedMovement[]>(),operations=new Set<string>(),invoices=new Set<string>();
 for(const m of movements){const list=byOperation.get(m.operationId)??[];list.push(m);byOperation.set(m.operationId,list);}
 for(const event of events){
  const op=event?.command?.operationId??null;
  if(op===null){add(null,null,'EVENT_UNREADABLE','Événement sans identifiant d’opération.');continue;}
  if(operations.has(op))add(event,op,'OPERATION_DUPLICATED','Identifiant d’opération présent deux fois.');operations.add(op);
  if(invoices.has(event.command.invoiceId))add(event,op,'INVOICE_CANCELLED_TWICE','Facture annulée par plus d’un avoir.');invoices.add(event.command.invoiceId);
  try{
   const computed=prepareFullCreditNote({actor:event.actor,command:event.command,source:event.source,daysOpen:true,previous:null}).event;
   if(canonicalJson(computed)!==canonicalJson(event))add(event,op,'EVENT_RECOMPUTE_MISMATCH','L’avoir enregistré diffère du recalcul des règles du domaine.');
  }catch(e){add(event,op,'EVENT_INVALID',e instanceof Error?e.message:'Avoir invalide.');continue;}
  if(event.refund+event.retainedCredit!==event.source.netPaid)add(event,op,'PAYMENT_NOT_ACCOUNTED','Remboursement + crédit conservé ≠ paiement net de la facture.');
  if(event.source.cancelled)add(event,op,'SOURCE_ALREADY_CANCELLED','La facture source était déjà annulée.');
  const own=byOperation.get(op)??[],cancellations=own.filter(m=>m.kind==='invoice_cancellation'),refunds=own.filter(m=>m.kind==='refund');
  if(own.length!==cancellations.length+refunds.length)add(event,op,'MOVEMENT_KIND_UNKNOWN','Mouvement de type inconnu.');
  if(cancellations.length!==1||big(cancellations[0].delta)!==-BigInt(event.noteTotal))add(event,op,'CANCELLATION_MOVEMENT_WRONG','Le mouvement d’annulation doit exister une fois et valoir −total de la facture.');
  if(event.refund>0){if(refunds.length!==1||big(refunds[0].delta)!==BigInt(event.refund))add(event,op,'REFUND_MOVEMENT_WRONG','Le mouvement de remboursement doit exister une fois et valoir le remboursement.');}
  else if(refunds.length>0)add(event,op,'REFUND_MOVEMENT_UNEXPECTED','Mouvement de remboursement sans remboursement.');
  const sum=own.reduce((a,m)=>a+(big(m.delta)??0n),0n);
  if(sum!==BigInt(event.balanceDelta))add(event,op,'BALANCE_DELTA_MISMATCH','La somme des mouvements ≠ variation du solde de l’avoir.');
 }
 for(const op of byOperation.keys())if(!operations.has(op))issues.push({operationId:op,invoiceId:null,code:'MOVEMENT_WITHOUT_EVENT',detail:'Mouvement de solde sans avoir enregistré.'});
 return {checked:events.length,issues};
}

/** Avoirs de factures préétablies. Le paiement de la facture seul est remboursé
 * ou conservé en crédit ; les règlements d'ancienne dette ne le sont jamais. */
import {calculatePreInvoiceCancellation} from './pre-invoice-credit-note.ts';
export type PreInvoiceCreditEventRecord={command:{operationId:string;invoiceId:string;recordedAt:string;choice:'refund'|'credit'|null};
 source:{invoice:{id:string;clientId:string;amount:number;createdAt:string};receipts:{createdAt:string}[]};clientId:string;
 creditNoteTotal:number;invoicePaid:number;oldDebtPaid:number;refund:number;retainedCredit:number;balanceDelta:number;balanceAfter:number;wasDeclared:boolean};
export function auditPreInvoiceCreditNotes(events:PreInvoiceCreditEventRecord[],movements:AuditedMovement[]):{checked:number;issues:CreditNoteAuditIssue[]}{
 const issues:CreditNoteAuditIssue[]=[];
 const add=(e:PreInvoiceCreditEventRecord|null,operationId:string|null,code:string,detail:string)=>issues.push({operationId:operationId??e?.command?.operationId??null,invoiceId:e?.command?.invoiceId??null,code,detail});
 const byOperation=new Map<string,AuditedMovement[]>(),operations=new Set<string>(),invoices=new Set<string>();
 for(const m of movements){const list=byOperation.get(m.operationId)??[];list.push(m);byOperation.set(m.operationId,list);}
 for(const event of events){
  const op=event?.command?.operationId??null;
  if(op===null){add(null,null,'EVENT_UNREADABLE','Événement sans identifiant d’opération.');continue;}
  if(operations.has(op))add(event,op,'OPERATION_DUPLICATED','Identifiant d’opération présent deux fois.');operations.add(op);
  if(invoices.has(event.command.invoiceId))add(event,op,'INVOICE_CANCELLED_TWICE','Facture préétablie annulée par plus d’un avoir.');invoices.add(event.command.invoiceId);
  try{
   const invoice=event.source.invoice;
   if(invoice.id!==event.command.invoiceId||invoice.clientId!==event.clientId)add(event,op,'IDENTITY_MISMATCH','Facture ou client de l’avoir différent de la source enregistrée.');
   const c=calculatePreInvoiceCancellation({balance:0,invoiceTotal:invoice.amount,receipts:event.source.receipts as never,alreadyCancelled:false,choice:event.command.choice??undefined});
   for(const key of ['creditNoteTotal','invoicePaid','oldDebtPaid','refund','retainedCredit','balanceDelta','balanceAfter','wasDeclared'] as const)
    if(c[key]!==event[key]){add(event,op,'EVENT_RECOMPUTE_MISMATCH',`Champ « ${key} » différent du recalcul des règles du domaine.`);break;}
   const last=Math.max(Date.parse(invoice.createdAt),...event.source.receipts.map(r=>Date.parse(r.createdAt)));
   if(!Number.isFinite(last)||Date.parse(event.command.recordedAt)<last)add(event,op,'NOTE_BEFORE_PAYMENT','Avoir daté avant la facture ou un de ses paiements.');
   if(event.refund+event.retainedCredit!==event.invoicePaid)add(event,op,'PAYMENT_NOT_ACCOUNTED','Remboursement + crédit conservé ≠ paiement de la facture (l’ancienne dette ne doit jamais y figurer).');
   const own=byOperation.get(op)??[],cancellations=own.filter(m=>m.kind==='invoice_cancellation'),refunds=own.filter(m=>m.kind==='refund');
   if(own.length!==cancellations.length+refunds.length)add(event,op,'MOVEMENT_KIND_UNKNOWN','Mouvement de type inconnu.');
   const expected=event.wasDeclared?-BigInt(invoice.amount):0n;
   if(cancellations.length!==1||big(cancellations[0].delta)!==expected)add(event,op,'CANCELLATION_MOVEMENT_WRONG','Le mouvement d’annulation doit exister une fois (−montant si la facture était déclarée, 0 sinon).');
   if(event.refund>0){if(refunds.length!==1||big(refunds[0].delta)!==BigInt(event.refund))add(event,op,'REFUND_MOVEMENT_WRONG','Le mouvement de remboursement doit exister une fois et valoir le remboursement.');}
   else if(refunds.length>0)add(event,op,'REFUND_MOVEMENT_UNEXPECTED','Mouvement de remboursement sans remboursement.');
   const sum=own.reduce((a,m)=>a+(big(m.delta)??0n),0n);
   if(sum!==BigInt(event.balanceDelta))add(event,op,'BALANCE_DELTA_MISMATCH','La somme des mouvements ≠ variation du solde de l’avoir.');
  }catch(e){add(event,op,'EVENT_INVALID',e instanceof Error?e.message:'Avoir invalide.');}
 }
 for(const op of byOperation.keys())if(!operations.has(op))issues.push({operationId:op,invoiceId:null,code:'MOVEMENT_WITHOUT_EVENT',detail:'Mouvement de solde sans avoir enregistré.'});
 return {checked:events.length,issues};
}

/** Cohérence arithmétique du journal du jour avec avoirs (vue serveur). Ne lit
 * pas la base : elle vérifie que les totaux annoncés découlent des lignes et des
 * événements du même journal. Ne remplace pas le comptage de la caisse physique. */
type JournalEvent={invoiceTotal:number;refund:number;retainedCredit:number};
export type CreditJournalView={totalBilled:number;billedAfterCredits:number;totalCollected:number;journalCollected:number;inheritedJournalTotal:number;globalSettlementTotal:number;
 saleRefundTotal:number;collectedAfterRefunds:number;creditNoteTotal:number;creditRefundTotal:number;creditRetainedTotal:number;creditRefundUnassignedTotal:number;
 creditEvents:JournalEvent[];creditCashEvents:JournalEvent[];unassignedCreditRefundEvents:JournalEvent[];
 rows:{clientId:string;preInvoicePaid:number;oldDebtPaid:number;tourPaid:number;totalCollected:number}[]};
export function auditCreditJournal(j:CreditJournalView):CreditNoteAuditIssue[]{
 const issues:CreditNoteAuditIssue[]=[];const bad=(code:string,detail:string,clientId:string|null=null)=>issues.push({operationId:null,invoiceId:clientId,code,detail});
 const sum=(xs:number[])=>xs.reduce((a,x)=>a+BigInt(x),0n),num=(x:unknown)=>Number.isSafeInteger(x)&&Number(x)>=0;
 const fields=[j.totalBilled,j.totalCollected,j.journalCollected,j.inheritedJournalTotal,j.globalSettlementTotal,j.saleRefundTotal,j.creditNoteTotal,j.creditRefundTotal,j.creditRetainedTotal,j.creditRefundUnassignedTotal];
 // « après avoirs » peut être négatif : un avoir du jour peut annuler une facture ou rembourser un paiement d'un autre jour.
 if(!fields.every(num)||!Number.isSafeInteger(j.billedAfterCredits)||!Number.isSafeInteger(j.collectedAfterRefunds)||!Array.isArray(j.rows)||!Array.isArray(j.creditEvents)||!Array.isArray(j.creditCashEvents)||!Array.isArray(j.unassignedCreditRefundEvents)){bad('JOURNAL_UNREADABLE','Totaux du journal manquants ou négatifs.');return issues;}
 for(const row of j.rows)if(BigInt(row.preInvoicePaid)+BigInt(row.oldDebtPaid)+BigInt(row.tourPaid)!==BigInt(row.totalCollected))bad('ROW_COLLECTED_MISMATCH','Encaissement du client ≠ préétablie + ancienne dette + ventes.',row.clientId);
 if(sum(j.rows.map(r=>r.totalCollected))!==BigInt(j.journalCollected))bad('JOURNAL_COLLECTED_MISMATCH','Encaissement du journal ≠ somme des lignes clients.');
 if(BigInt(j.journalCollected)+BigInt(j.inheritedJournalTotal)+BigInt(j.globalSettlementTotal)!==BigInt(j.totalCollected))bad('TOTAL_COLLECTED_MISMATCH','Total encaissé ≠ journal + hérité + règlements globaux.');
 if(sum(j.creditEvents.map(e=>e.invoiceTotal))!==BigInt(j.creditNoteTotal))bad('CREDIT_TOTAL_MISMATCH','Total des avoirs ≠ somme de leurs factures.');
 if(sum(j.creditEvents.map(e=>e.retainedCredit))!==BigInt(j.creditRetainedTotal))bad('RETAINED_TOTAL_MISMATCH','Crédit conservé ≠ somme des événements.');
 if(sum(j.creditCashEvents.map(e=>e.refund))!==BigInt(j.creditRefundTotal))bad('REFUND_TOTAL_MISMATCH','Remboursements en caisse ≠ somme des événements.');
 if(sum(j.unassignedCreditRefundEvents.map(e=>e.refund))!==BigInt(j.creditRefundUnassignedTotal))bad('UNASSIGNED_REFUND_MISMATCH','Remboursements non attribués ≠ somme des événements.');
 if(BigInt(j.totalBilled)-BigInt(j.creditNoteTotal)!==BigInt(j.billedAfterCredits))bad('BILLED_AFTER_MISMATCH','Facturé après avoirs ≠ facturé − avoirs.');
 if(BigInt(j.totalCollected)-BigInt(j.creditRefundTotal)-BigInt(j.saleRefundTotal)!==BigInt(j.collectedAfterRefunds))bad('COLLECTED_AFTER_MISMATCH','Encaissé après remboursements ≠ encaissé − remboursements d’avoirs − remboursements de ventes.');
 return issues;
}

/** Rapprochement des remises de remboursement avec les avoirs. Une remise manquante
 * n'est pas une anomalie : le remboursement est simplement « à confirmer ». */
export type RefundNoteRecord={operationId:string;clientId:string;recordedAt:string;refund:number};
export type RefundHandoverRecord={noteOperationId:string;beneficiaryClientId:string;amount:string|number|bigint;handedAt:string};
export function auditRefundHandovers(notes:RefundNoteRecord[],handovers:RefundHandoverRecord[]):{checked:number;pending:RefundNoteRecord[];pendingTotal:number;issues:CreditNoteAuditIssue[]}{
 const issues:CreditNoteAuditIssue[]=[],byNote=new Map(notes.map(n=>[n.operationId,n])),seen=new Set<string>();
 const bad=(operationId:string,code:string,detail:string)=>issues.push({operationId,invoiceId:null,code,detail});
 for(const h of handovers){
  if(seen.has(h.noteOperationId))bad(h.noteOperationId,'HANDOVER_DUPLICATED','Plusieurs remises pour le même avoir.');seen.add(h.noteOperationId);
  const note=byNote.get(h.noteOperationId);
  if(!note){bad(h.noteOperationId,'HANDOVER_WITHOUT_NOTE','Remise enregistrée pour un avoir inconnu.');continue;}
  if(!(note.refund>0))bad(h.noteOperationId,'HANDOVER_WITHOUT_REFUND','Remise enregistrée pour un avoir sans remboursement.');
  if(big(h.amount)!==BigInt(note.refund))bad(h.noteOperationId,'HANDOVER_AMOUNT_MISMATCH','Montant remis ≠ remboursement de l’avoir.');
  if(h.beneficiaryClientId!==note.clientId)bad(h.noteOperationId,'HANDOVER_BENEFICIARY_MISMATCH','Bénéficiaire ≠ client de l’avoir.');
  if(Date.parse(h.handedAt)<Date.parse(note.recordedAt))bad(h.noteOperationId,'HANDOVER_BEFORE_NOTE','Remise datée avant l’avoir.');
 }
 const pending=notes.filter(n=>n.refund>0&&!seen.has(n.operationId));
 return {checked:handovers.length,pending,pendingTotal:Number(pending.reduce((a,n)=>a+BigInt(n.refund),0n)),issues};
}
