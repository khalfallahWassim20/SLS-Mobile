/** Vue d'historique préparatoire : ne pas exposer avant raccordement de toutes
 * les écritures, références, interfaces et exports au protocole d'avoirs. */
import type {Pool,PoolClient} from 'pg';
import {canonicalJson,summarizePreInvoice} from '@sls/domain';
import {readPrototypeCreditReferenceInTransaction} from './credit-note-reference-prototype.js';
import {assertIdentifiedMode,lockSyncMode} from './tour-sync-mode.js';

function tunisDay(value:string) {
 const date=new Date(value);
 if(!Number.isFinite(date.getTime()))throw new RangeError('Date d’avoir invalide.');
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
 const part=(name:string)=>parts.find(p=>p.type===name)?.value;
 return `${part('year')}-${part('month')}-${part('day')}`;
}
/** Les mouvements, facture et solde proviennent d'un même instantané MVCC.
 * L'historique garde les montants d'origine ; il ne transforme jamais l'avoir
 * en règlement de l'ancienne dette. */
export async function readPrototypeCreditHistoryInTransaction(db:PoolClient) {
  const reference=await readPrototypeCreditReferenceInTransaction(db);
  const clients=new Map(reference.clients.map(c=>[c.id,c.name]));
  const sales=await db.query(`SELECT n.operation_id,n.invoice_id,n.event,
   first.commercial_id AS owner_id,first.journal_date::text AS invoice_day,
   latest.client_id,latest.payload->'sale' AS sale
   FROM credit_note_prototype_events n
   JOIN LATERAL (SELECT commercial_id,journal_date FROM identified_sale_events WHERE sale_id=n.invoice_id ORDER BY version ASC LIMIT 1) first ON true
   JOIN LATERAL (SELECT client_id,payload FROM identified_sale_events WHERE sale_id=n.invoice_id ORDER BY version DESC LIMIT 1) latest ON true`);
  const pres=await db.query(`SELECT n.operation_id,n.invoice_id,n.event,i.commercial_id AS owner_id,i.journal_date::text AS invoice_day,i.client_id
   FROM pre_invoice_credit_prototype_events n JOIN identified_journal_invoices i ON i.id=n.invoice_id`);
  const saleById=new Map(reference.saleStates.map(s=>[s.saleId,s]));
  const preById=new Map(reference.journalStates.map(s=>[s.id,s]));
  const records=[];
  for(const row of sales.rows){
   const event=row.event,marker=saleById.get(row.invoice_id),name=clients.get(row.client_id);
   if(!marker?.creditNote||canonicalJson(event)!==canonicalJson(marker.creditNote)||!name||!row.owner_id||!row.sale||row.sale.clientId!==row.client_id)throw new RangeError('Historique d’avoir de vente incohérent.');
   records.push({kind:'sale' as const,operationId:row.operation_id,invoiceId:row.invoice_id,invoiceDay:row.invoice_day,recordedAt:event.command.recordedAt,recordedDay:tunisDay(event.command.recordedAt),clientId:row.client_id,clientName:name,ownerId:row.owner_id,actor:event.actor,version:event.command.expectedVersion,invoiceTotal:event.noteTotal,netPaid:event.source.netPaid,oldDebtPaid:0,wasDeclared:true,refund:event.refund,retainedCredit:event.retainedCredit,balanceDelta:event.balanceDelta});
  }
  for(const row of pres.rows){
   const e=row.event,marker=preById.get(row.invoice_id),name=clients.get(row.client_id),command=e.command;
   if(!marker?.creditNote||marker.creditNote.operationId!==row.operation_id||!name||!row.owner_id||e.clientId!==row.client_id||e.ownerId!==row.owner_id||e.source.invoice.journalDate!==row.invoice_day)throw new RangeError('Historique d’avoir préétabli incohérent.');
   records.push({kind:'preinvoice' as const,operationId:row.operation_id,invoiceId:row.invoice_id,invoiceDay:row.invoice_day,recordedAt:command.recordedAt,recordedDay:tunisDay(command.recordedAt),clientId:row.client_id,clientName:name,ownerId:row.owner_id,actor:e.actor,version:command.expectedVersion,invoiceTotal:e.source.invoice.amount,netPaid:summarizePreInvoice(e.source.invoice.amount,e.source.receipts).prePaid,oldDebtPaid:e.oldDebtPaid,wasDeclared:e.wasDeclared,refund:e.refund,retainedCredit:e.retainedCredit,balanceDelta:e.balanceDelta});
  }
  if(records.length!==reference.saleStates.filter(s=>s.creditNote).length+reference.journalStates.filter(j=>j.creditNote).length)throw new RangeError('Historique d’avoirs incomplet.');
  const assignments=await db.query(`SELECT note_operation_id AS "noteOperationId",request_id AS "requestId",commercial_id AS "commercialId",refund::text AS refund,actor_id AS "actorId",assigned_at AS "assignedAt" FROM credit_refund_assignment_prototype`);
  const byNote=new Map(records.map(record=>[record.operationId,record])),assigned=new Map<string,{requestId:string;commercialId:string|null;actorId:string;assignedAt:string}>();
  const uuid=(s:unknown)=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  for(const row of assignments.rows){
   const record=byNote.get(row.noteOperationId),date=new Date(row.assignedAt);
   if(!record||record.actor.role!=='admin'||record.refund<=0||row.refund!==String(record.refund)||!uuid(row.requestId)||(row.commercialId!==null&&!uuid(row.commercialId))||typeof row.actorId!=='string'||!row.actorId.trim()||row.actorId.length>200||!Number.isFinite(date.getTime())||assigned.has(row.noteOperationId))throw new RangeError('Attribution de remboursement incohérente.');
   assigned.set(row.noteOperationId,{requestId:row.requestId,commercialId:row.commercialId,actorId:row.actorId,assignedAt:date.toISOString()});
  }
  return records.map(record=>({...record,cashAssignment:assigned.get(record.operationId)??null})).sort((a,b)=>b.recordedAt.localeCompare(a.recordedAt)||a.operationId.localeCompare(b.operationId));
}
export async function readPrototypeCreditHistory(pool:Pool) {
 const db=await pool.connect();
 try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));
  const records=await readPrototypeCreditHistoryInTransaction(db);
  await db.query('COMMIT');return records;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
