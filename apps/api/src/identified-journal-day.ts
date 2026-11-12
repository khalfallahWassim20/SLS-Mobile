/** Vue interne par commercial, limitée aux données identifiées et non exposée. */
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {buildServerJournalDay} from './journal-day.js';
import {journalDateSchema,parseJournalSnapshot} from './journal-protocol.js';
import {lockSyncMode,assertIdentifiedMode} from './tour-sync-mode.js';
import {assertOldCreditProtocolSafe} from './credit-note-active-guards.js';

/** L'appelant doit fournir un instantané REPEATABLE READ ; cette fonction ne
 * vérifie pas le protocole et ne doit pas être utilisée seule par une route. */
export async function readIdentifiedJournalDayInTransaction(db:PoolClient,commercialId:string,day:string) {
 z.string().uuid().parse(commercialId);journalDateSchema.parse(day);
  const commercial=await db.query('SELECT id,name FROM commercials WHERE id=$1 AND deleted_at IS NULL',[commercialId]);
  if(!commercial.rows.length)throw new RangeError('Commercial introuvable.');
  const invoices=await db.query(`SELECT DISTINCT ON (e.invoice_id) e.payload FROM identified_journal_events e
   JOIN identified_journal_invoices i ON i.id=e.invoice_id WHERE i.commercial_id=$1 AND i.journal_date=$2::date
   ORDER BY e.invoice_id,e.version DESC`,[commercialId,day]);
  // La vente reste dans le journal de son créateur, même modifiée par un autre commercial.
  const sales=await db.query(`WITH first AS (SELECT DISTINCT ON (sale_id) sale_id,commercial_id,journal_date FROM identified_sale_events WHERE version=1 ORDER BY sale_id,version ASC),
   latest AS (SELECT DISTINCT ON (sale_id) sale_id,payload FROM identified_sale_events ORDER BY sale_id,version DESC)
   SELECT l.sale_id AS "saleId",l.payload->'sale' AS sale FROM latest l JOIN first f ON f.sale_id=l.sale_id
   WHERE f.commercial_id=$1 AND f.journal_date=$2::date`,[commercialId,day]);
  const settlements=await db.query(`SELECT count(*)::int AS count,COALESCE(sum((payload->'settlement'->>'amount')::bigint),0)::text AS amount
   FROM identified_settlements WHERE commercial_id=$1 AND journal_date=$2::date`,[commercialId,day]);
  const closure=await db.query(`SELECT status,version,closed_at FROM tour_closures WHERE commercial_id=$1 AND journal_date=$2::date`,[commercialId,day]);
  // La facture d'origine n'a pas d'auteur connu : ne pas l'attribuer à l'auteur d'un paiement ultérieur.
  const inherited=await db.query(`SELECT e.payload FROM identified_journal_events e JOIN identified_journal_invoices i ON i.id=e.invoice_id
   WHERE i.commercial_id IS NULL AND e.commercial_id=$1 AND i.journal_date=$2::date ORDER BY e.invoice_id,e.version`,[commercialId,day]);
  const inheritedByClient=new Map<string,{clientId:string;clientName:string;prePaid:bigint;oldDebtPaid:bigint}>();
  for(const row of inherited.rows){
   const event=parseJournalSnapshot(row.payload),receipt=event.receipts.at(-1);
   if(!receipt)throw new RangeError('Historique hérité de facture incomplet.');
   let item=inheritedByClient.get(event.invoice.clientId);
   if(!item){item={clientId:event.invoice.clientId,clientName:event.invoice.clientName,prePaid:0n,oldDebtPaid:0n};inheritedByClient.set(item.clientId,item);}
   item.prePaid+=BigInt(receipt.prePaid);item.oldDebtPaid+=BigInt(receipt.oldDebtPaid);
  }
  const inheritedTotal=[...inheritedByClient.values()].reduce((n,p)=>n+p.prePaid+p.oldDebtPaid,0n);

  const dayResult=buildServerJournalDay(day,invoices.rows.map(r=>r.payload),sales.rows.map(r=>({...r.sale,saleId:r.saleId})));
  const total=BigInt(dayResult.totalCollected)+BigInt(settlements.rows[0].amount)+inheritedTotal;
  if(total>BigInt(Number.MAX_SAFE_INTEGER)||total<BigInt(Number.MIN_SAFE_INTEGER))throw new RangeError('Total encaissé trop élevé.');
  const events=await db.query(`SELECT action,actor_id AS "actorId",actor_role AS "actorRole",occurred_at AS "occurredAt",version
   FROM tour_closure_events WHERE commercial_id=$1 AND journal_date=$2::date ORDER BY version DESC LIMIT 200`,[commercialId,day]);
  const inheritedPayments=[...inheritedByClient.values()].map(p=>{if(p.prePaid>BigInt(Number.MAX_SAFE_INTEGER)||p.oldDebtPaid>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Total encaissé trop élevé.');return {clientId:p.clientId,clientName:p.clientName,prePaid:Number(p.prePaid),oldDebtPaid:Number(p.oldDebtPaid)};});
  const state=closure.rows[0];
  return {...dayResult,commercial:commercial.rows[0],closure:{status:state?.status??'open',version:state?.version??0,closedAt:state?.closed_at?new Date(state.closed_at).toISOString():null},
   journalCollected:dayResult.totalCollected,inheritedJournalPayments:inheritedPayments,inheritedJournalTotal:Number(inheritedTotal),globalSettlementCount:settlements.rows[0].count,globalSettlementTotal:Number(settlements.rows[0].amount),totalCollected:Number(total),closureEvents:events.rows};
}
export async function readIdentifiedJournalDay(pool:Pool,commercialId:string,day:string,enforceMode=false) {
 const db=await pool.connect();
 try {
  await db.query(enforceMode?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  if(enforceMode)assertIdentifiedMode(await lockSyncMode(db));
  await assertOldCreditProtocolSafe(db);
  const result=await readIdentifiedJournalDayInTransaction(db,commercialId,day);
  await db.query('COMMIT');return result;
 } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
