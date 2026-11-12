/** Comparaison non destructive du journal, des règlements et des avoirs ;
 * les ventes sont comparées séparément et la clôture n'est pas débloquée. */
import {validateCashReconciliation,type CashReconciliationEntry} from '@sls/domain';
import {readCreditJournalExportPrototype} from './credit-note-journal-export-prototype';
import {journalCsv} from './journal-export';
import {tunisDay} from './journal';
import type {DeviceIdentity} from './identified-device';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
export async function readLocalJournalCashReconciliation(tx:Tx,identity:DeviceIdentity,day:string,digest:(text:string)=>Promise<string>){
 const journal=await readCreditJournalExportPrototype(tx,identity,day,'Comparaison',digest);journalCsv(journal);
 if(!journal.adminRefundAssignmentsKnown)throw Error('Attributions administrateur indisponibles : synchronisez.');
 const events:CashReconciliationEntry[]=[];
 async function operation(invoiceId:string,recordedAt:string){
  const rows=await tx.getAllAsync<{operationId:string}>(`SELECT operation_id AS operationId FROM identified_local_operations WHERE operation_kind='journal' AND entity_id=? AND commercial_id=? AND recorded_at=?`,invoiceId,identity.commercialId,recordedAt);
  if(rows.length!==1)throw Error('Origine du journal ambiguë : comparaison impossible.');return rows[0].operationId;
 }
 for(const row of journal.rows){const p=row.preInvoice;if(!p)continue;
  events.push({kind:'invoice',operationId:await operation(p.id,p.createdAt),invoiceId:p.id,clientId:p.clientId,recordedAt:p.createdAt,amount:p.amount});
 }
 for(const p of journal.receipts.filter(r=>r.journalDate===day))events.push({kind:'receipt',operationId:await operation(p.preInvoiceId,p.createdAt),invoiceId:p.preInvoiceId,receiptId:p.id,clientId:p.clientId,recordedAt:p.createdAt,prePaid:p.prePaid,oldDebtPaid:p.oldDebtPaid,creditFull:p.creditFull,mode:p.mode,chequeNumber:p.chequeNumber,chequeBank:p.chequeBank,chequeDue:p.chequeDue});
 const settlements=await tx.getAllAsync<{clientId:string;payload:string}>('SELECT client_id AS clientId,payload FROM settlements ORDER BY id');
 for(const row of settlements){
  let p:Record<string,any>;try{p=JSON.parse(row.payload);if(!p||typeof p!=='object'||Array.isArray(p)||p.clientId!==row.clientId||typeof p.createdAt!=='string'||!Number.isFinite(Date.parse(p.createdAt)))throw Error();}catch{throw Error('Règlement local illisible.');}
  if(tunisDay(new Date(p.createdAt))!==day)continue;
  const marker=await tx.getFirstAsync<{n:number}>(`SELECT count(*) AS n FROM identified_local_operations WHERE operation_id=? AND operation_kind='settlement' AND entity_id=? AND commercial_id=? AND recorded_at=?`,p.syncOperationId,p.syncOperationId,identity.commercialId,p.createdAt);
  if(marker?.n!==1)throw Error('Origine du règlement local non prouvée.');
  events.push({kind:'settlement',operationId:p.syncOperationId,clientId:p.clientId,recordedAt:p.createdAt,amount:p.amount,mode:p.mode,chequeNumber:p.chequeNumber,chequeBank:p.chequeBank,chequeDue:p.chequeDue});
 }
 for(const {note} of journal.credits??[]){if(tunisDay(new Date(note.command.recordedAt))!==day)continue;
  const source=note.source as Record<string,any>,invoice=note.kind==='sale'?source:source.invoice;
  events.push({kind:'credit',operationId:note.command.operationId,clientId:invoice.clientId,recordedAt:note.command.recordedAt,invoiceId:note.command.invoiceId,invoiceKind:note.kind,invoiceTotal:note.kind==='sale'?invoice.total:invoice.amount,refund:note.refund,retainedCredit:note.retainedCredit});
 }
 for(const p of journal.adminCreditRefunds??[])events.push({kind:'admin-refund',operationId:p.noteOperationId,clientId:p.clientId,recordedAt:p.recordedAt,invoiceId:p.invoiceId,invoiceKind:p.kind,assignmentId:p.assignmentId,refund:p.refund});
 const result={version:5 as const,commercialId:identity.commercialId,day,events};validateCashReconciliation(result,identity.commercialId,day);return result;
}
