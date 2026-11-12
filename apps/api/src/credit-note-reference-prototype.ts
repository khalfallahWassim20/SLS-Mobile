import {creditAbandonInputSchema} from './credit-note-abandon-prototype.js';
/** Projection intégrée réservée aux tests. Aucun routeur actif ne l'expose ;
 * elle ne rend pas les registres expérimentaux utilisables en production. */
import type {Pool,PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson,calculatePreInvoiceCancellation,type CreditNoteEvent} from '@sls/domain';
import {readIdentifiedReferenceInTransaction} from './identified-reference.js';
import {assertIdentifiedMode,lockSyncMode} from './tour-sync-mode.js';
import {parseJournalSnapshot} from './journal-protocol.js';
import {projectPrototypeCreditNotes} from './credit-note-projection-prototype.js';
const actorSchema=z.object({id:z.string().trim().min(1).max(200),role:z.enum(['admin','commercial'])}).strict().refine(a=>a.role!=='commercial'||z.string().uuid().safeParse(a.id).success);
const commandSchema=z.object({operationId:z.string().uuid(),invoiceId:z.string().uuid(),expectedVersion:z.number().int().min(1).max(999999),recordedAt:z.string().datetime({precision:3}),choice:z.enum(['refund','credit']).nullable()}).strict();
function safeString(n:bigint) {
 if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw new RangeError('Solde trop élevé.');
 return n.toString();
}
function asNumber(value:unknown):number {
 if(typeof value!=='string'||! /^-?\d+$/.test(value))throw new RangeError('Montant enregistré invalide.');
 return Number(safeString(BigInt(value)));
}
/** L'ancien solde et les nouveaux mouvements sont lus sous REPEATABLE READ.
 * Toute corruption ou version modifiée après avoir entraîne un refus complet. */
export async function readPrototypeCreditReferenceInTransaction(db:PoolClient) {
  const base=await readIdentifiedReferenceInTransaction(db,true);
  const saleNotes=await db.query('SELECT operation_id,invoice_id,event FROM credit_note_prototype_events');
  const preNotes=await db.query('SELECT operation_id,invoice_id,event FROM pre_invoice_credit_prototype_events');
  const ids=await db.query('SELECT operation_id FROM credit_note_prototype_operation_ids');
  const otherOperations=await db.query(`SELECT operation_id FROM demo_sale_events UNION ALL SELECT operation_id FROM identified_sale_events UNION ALL
   SELECT operation_id FROM demo_settlements UNION ALL SELECT operation_id FROM identified_settlements UNION ALL
   SELECT operation_id FROM sync_journal_events UNION ALL SELECT operation_id FROM identified_journal_events`);
  const seen=new Set(otherOperations.rows.map(r=>r.operation_id));
  const noteIds=new Set<string>();
  for(const row of [...saleNotes.rows,...preNotes.rows]){
   if(seen.has(row.operation_id)||noteIds.has(row.operation_id)||row.event?.command?.operationId!==row.operation_id||row.event?.command?.invoiceId!==row.invoice_id)throw new RangeError('Identifiant d’avoir incohérent ou dupliqué.');
   noteIds.add(row.operation_id);
  }
  const abandoned=await db.query('SELECT operation_id,kind,invoice_id,commercial_id,command FROM credit_note_abandon_prototype');
  const allIds=new Set(noteIds);
  for(const row of abandoned.rows){
   const value=creditAbandonInputSchema.parse({kind:row.kind,command:row.command});
   if(seen.has(row.operation_id)||allIds.has(row.operation_id)||value.command.operationId!==row.operation_id||value.command.invoiceId!==row.invoice_id||typeof row.commercial_id!=='string')throw new RangeError('Identifiant d’abandon incohérent.');
   allIds.add(row.operation_id);
  }
  if(ids.rows.length!==allIds.size||ids.rows.some(r=>!allIds.has(r.operation_id)))throw new RangeError('Registre des identifiants incohérent.');
  const saleMovements=await db.query('SELECT operation_id,kind,balance_delta::text AS delta FROM credit_note_prototype_movements');
  const balances=projectPrototypeCreditNotes(base.clients.map(c=>({clientId:c.id,balance:asNumber(c.serverBalance)})),base.saleStates.map(s=>({invoiceId:s.saleId,clientId:s.clientId,version:s.version,total:asNumber(s.total),netPaid:asNumber(s.paid)})),saleNotes.rows.map(r=>r.event as CreditNoteEvent),saleMovements.rows.map(r=>({operationId:r.operation_id,kind:r.kind,balanceDelta:asNumber(r.delta)})));
  const projectedBalances=new Map(balances.map(b=>[b.clientId,b.balance]));
  const clients=new Map(base.clients.map(c=>[c.id,{...c,serverBalance:String(projectedBalances.get(c.id)!)}]));
  // Preuve du contenu complet de la facture annulée : les totaux seuls ne
  // suffisent pas pour reconnaître une annulation faite sur un autre appareil.
  const saleProofs=[];
  for(const row of saleNotes.rows){
   const found=await db.query('SELECT version,client_id,payload FROM identified_sale_events WHERE sale_id=$1 ORDER BY version DESC LIMIT 1',[row.invoice_id]);
   const saved=found.rows[0],event=row.event as CreditNoteEvent,sale=saved?.payload?.sale;
   if(!saved||!sale||saved.version!==event.command.expectedVersion||sale.syncSaleId!==row.invoice_id||sale.syncVersion!==saved.version||sale.clientId!==saved.client_id||sale.total!==event.source.total||sale.paid!==event.source.netPaid)throw new RangeError('Source de vente annulée incohérente.');
   saleProofs.push({saleId:row.invoice_id,version:saved.version,hash:createHash('sha256').update(canonicalJson(sale)).digest('hex')});
  }
  const saleById=new Map(saleNotes.rows.map(r=>[r.invoice_id,r.event as CreditNoteEvent]));
  const saleStates=base.saleStates.map(s=>{
   const e=saleById.get(s.saleId);
   return e?{...s,version:e.resultVersion,total:'0',paid:String(e.retainedCredit),cancelled:true,creditNote:e}:{...s,cancelled:false,creditNote:null};
  });
  const movementRows=await db.query('SELECT operation_id,kind,balance_delta::text AS delta FROM pre_invoice_credit_prototype_movements');
  const movements=new Map<string,Map<string,number>>(),preIds=new Set(preNotes.rows.map(r=>r.operation_id));
  for(const row of movementRows.rows){
   if(!noteIds.has(row.operation_id)||!preIds.has(row.operation_id)||!['invoice_cancellation','refund'].includes(row.kind))throw new RangeError('Mouvement de préétablie incohérent.');
   const group=movements.get(row.operation_id)??new Map<string,number>();
   if(group.has(row.kind))throw new RangeError('Mouvement de préétablie dupliqué.');
   group.set(row.kind,asNumber(row.delta));movements.set(row.operation_id,group);
  }
  const preById=new Map<string,{command:z.infer<typeof commandSchema>;actor:z.infer<typeof actorSchema>;version:number}>();
  for(const row of preNotes.rows) {
   const event=row.event,command=commandSchema.parse(event?.command),actor=actorSchema.parse(event?.actor);
   if(new Date(command.recordedAt).toISOString()!==command.recordedAt)throw new RangeError('Date d’avoir invalide.');
   const source=parseJournalSnapshot(event.source);
   const latest=await db.query(`SELECT e.payload,i.client_id,i.commercial_id FROM identified_journal_events e JOIN identified_journal_invoices i ON i.id=e.invoice_id WHERE e.invoice_id=$1 ORDER BY e.version DESC LIMIT 1`,[row.invoice_id]);
   const state=latest.rows[0];
   if(!state||!state.commercial_id||source.version!==command.expectedVersion||source.invoice.id!==command.invoiceId||source.invoice.clientId!==state.client_id||canonicalJson(state.payload)!==canonicalJson(source))throw new RangeError('Version de préétablie modifiée après avoir.');
   const old=await db.query('SELECT 1 FROM sync_journal_invoices WHERE id=$1',[row.invoice_id]);
   if(old.rows.length)throw new RangeError('Ancienne préétablie non rapprochée.');
   const result=calculatePreInvoiceCancellation({balance:0,invoiceTotal:source.invoice.amount,receipts:source.receipts,alreadyCancelled:false,choice:command.choice??undefined});
   const expected={command,actor,source,clientId:state.client_id,ownerId:state.commercial_id,...result};
   if(canonicalJson(expected)!==canonicalJson(event))throw new RangeError('Avoir de préétablie incohérent.');
   const m=movements.get(row.operation_id),expectedInvoice=result.wasDeclared?-source.invoice.amount:0;
   if(!m||m.get('invoice_cancellation')!==expectedInvoice||m.size!==(result.refund>0?2:1)||(result.refund>0&&m.get('refund')!==result.refund))throw new RangeError('Mouvements de préétablie incohérents.');
   const client=clients.get(state.client_id);if(!client)throw new RangeError('Client de préétablie introuvable.');
   client.serverBalance=safeString(BigInt(client.serverBalance)+BigInt(result.balanceDelta));
   preById.set(row.invoice_id,{command,actor,version:source.version});
  }
  // Sources identifiées reconnues pour un autre appareil. Les anciens
  // espaces restent exclus : ils ne sont pas automatiquement annulables.
  const eligibleSales=await db.query(`WITH latest AS (SELECT DISTINCT ON (sale_id) sale_id,version,client_id,payload FROM identified_sale_events ORDER BY sale_id,version DESC)
   SELECT l.sale_id,l.version,l.client_id,l.payload FROM latest l
   WHERE NOT EXISTS(SELECT 1 FROM demo_sale_events d WHERE d.sale_id=l.sale_id)
    AND (SELECT count(*) FROM identified_sale_events e WHERE e.sale_id=l.sale_id)=l.version`);
  const eligibleSaleProofs=eligibleSales.rows.map(row=>{
   const state=saleStates.find(s=>s.saleId===row.sale_id),sale=row.payload?.sale;
   if(!state||state.creditNote)return null;
   if(!sale||sale.syncSaleId!==row.sale_id||sale.syncVersion!==row.version||sale.clientId!==row.client_id||state.clientId!==row.client_id||state.version!==row.version||String(sale.total)!==state.total||String(sale.paid)!==state.paid)throw new RangeError('Source de vente identifiée incohérente.');
   return {saleId:row.sale_id,version:row.version,hash:createHash('sha256').update(canonicalJson(sale)).digest('hex')};
  }).filter((p):p is {saleId:string;version:number;hash:string}=>p!==null);
  const eligibleJournals=await db.query(`SELECT i.id FROM identified_journal_invoices i
   WHERE i.commercial_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sync_journal_invoices s WHERE s.id=i.id)`);
  const knownJournals=new Set(base.journalStates.map(s=>s.id));
  const eligibleJournalIds=eligibleJournals.rows.map(r=>r.id as string).filter(id=>knownJournals.has(id)&&!preById.has(id));
  const proofs=new Map(base.journalProofs.map(p=>[p.id,p]));
  const journalStates=base.journalStates.map(s=>{
   const item=preById.get(s.id),proof=proofs.get(s.id);
   if(!proof)throw new RangeError('Version de journal introuvable.');
   return {...s,version:proof.version,creditNote:item?{operationId:item.command.operationId,expectedVersion:item.version,choice:item.command.choice,recordedAt:item.command.recordedAt,actor:item.actor}:null};
  });
  if(preById.size!==journalStates.filter(s=>s.creditNote).length)throw new RangeError('Préétablie annulée introuvable.');
  // Garder les clients inactifs et leur historique pour rapprocher les
  // opérations hors ligne ; seul le sélecteur mobile doit les masquer.
  const statuses=await db.query('SELECT id,active,status_revision::text AS "statusRevision" FROM clients WHERE deleted_at IS NULL');
  const statusById=new Map(statuses.rows.map(r=>[r.id,r]));
  const allClients=[...clients.values()].map(c=>{
   const status=statusById.get(c.id);
   if(!status||typeof status.active!=='boolean'||typeof status.statusRevision!=='string'||!/^\d+$/.test(status.statusRevision)||BigInt(status.statusRevision)<1n)throw new RangeError('Statut client indisponible.');
   return {...c,active:status.active,statusRevision:status.statusRevision as string};
  });
  const assignedRows=await db.query(`SELECT note_operation_id AS "noteOperationId",request_id AS "requestId",commercial_id AS "commercialId",refund::text AS refund,actor_id AS "actorId",assigned_at AS "assignedAt" FROM credit_refund_assignment_prototype`);
  const allNotes=new Map([...saleNotes.rows,...preNotes.rows].map(r=>[r.operation_id,r.event]));
  const assignmentIds=new Set<string>();
  const cashAssignments=assignedRows.rows.map(r=>{
   const event=allNotes.get(r.noteOperationId),date=new Date(r.assignedAt);
   if(!event||event.actor?.role!=='admin'||!Number.isSafeInteger(event.refund)||event.refund<=0||r.refund!==String(event.refund)||!z.string().uuid().safeParse(r.requestId).success||(r.commercialId!==null&&!z.string().uuid().safeParse(r.commercialId).success)||typeof r.actorId!=='string'||!r.actorId.trim()||r.actorId.length>200||!Number.isFinite(date.getTime())||assignmentIds.has(r.noteOperationId))throw new RangeError('Attribution de remboursement incohérente.');
   assignmentIds.add(r.noteOperationId);return {noteOperationId:r.noteOperationId as string,requestId:r.requestId as string,commercialId:r.commercialId as string|null,refund:event.refund as number,actorId:r.actorId as string,assignedAt:date.toISOString()};
  });
  // Propriétaire de la facture d’origine, distinct de l’auteur de l’avoir.
  // Un propriétaire historique absent reste inconnu et ne doit pas servir à
  // débloquer une clôture. La liste couvre exactement les avoirs vérifiés.
  const ownerRows=await db.query(`SELECT n.operation_id,first.commercial_id AS owner_id
   FROM credit_note_prototype_events n LEFT JOIN LATERAL
   (SELECT commercial_id FROM identified_sale_events WHERE sale_id=n.invoice_id ORDER BY version LIMIT 1) first ON true
   UNION ALL SELECT n.operation_id,i.commercial_id AS owner_id
   FROM pre_invoice_credit_prototype_events n LEFT JOIN identified_journal_invoices i ON i.id=n.invoice_id`);
  if(ownerRows.rows.length!==noteIds.size||new Set(ownerRows.rows.map(r=>r.operation_id)).size!==noteIds.size||ownerRows.rows.some(r=>!noteIds.has(r.operation_id)))throw new RangeError('Propriétaires des avoirs incomplets.');
  const creditOwners=ownerRows.rows.map(r=>({operationId:r.operation_id,ownerId:r.owner_id as string|null})).sort((a,b)=>a.operationId.localeCompare(b.operationId));
  return {experimental:true as const,version:5 as const,clients:allClients,articles:base.articles,saleStates,saleProofs,eligibleSaleProofs,eligibleJournalIds,settlementStates:base.settlementStates,journalStates,journalProofs:base.journalProofs,cashAssignments,creditOwners};
}
/** En v5 les inactifs sont conservés pour le rapprochement, jamais pour la
 * sélection de nouveaux clients. La différence active/inactive est explicite. */
export async function readPrototypeCreditReference(pool:Pool,_includeInactive=true) {
 const db=await pool.connect();
 try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));
  const result=await readPrototypeCreditReferenceInTransaction(db);
  await db.query('COMMIT');return result;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
