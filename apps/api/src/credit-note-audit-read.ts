/** Lecture seule des avoirs (ventes et préétablies) et de leurs mouvements, pour l'audit. */
import {auditCreditNotes,auditPreInvoiceCreditNotes,type CreditNoteEvent,type AuditedMovement,type PreInvoiceCreditEventRecord} from '@sls/domain';
type Db={query:(sql:string,params?:unknown[])=>Promise<{rows:any[]}>};
export async function auditStoredCreditNotes(db:Db){
 const events=await db.query('SELECT event FROM credit_note_prototype_events ORDER BY received_at,operation_id');
 const movements=await db.query('SELECT operation_id AS "operationId",kind,balance_delta::text AS delta FROM credit_note_prototype_movements');
 return auditCreditNotes(events.rows.map(r=>r.event as CreditNoteEvent),movements.rows as AuditedMovement[]);
}
export async function auditStoredPreInvoiceCreditNotes(db:Db){
 const events=await db.query('SELECT event FROM pre_invoice_credit_prototype_events ORDER BY received_at,operation_id');
 const movements=await db.query('SELECT operation_id AS "operationId",kind,balance_delta::text AS delta FROM pre_invoice_credit_prototype_movements');
 return auditPreInvoiceCreditNotes(events.rows.map(r=>r.event as PreInvoiceCreditEventRecord),movements.rows as AuditedMovement[]);
}
