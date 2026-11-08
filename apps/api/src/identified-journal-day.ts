/** Vue interne par commercial, limitée aux données identifiées et non exposée. */
import type {Pool} from 'pg';
import {z} from 'zod';
import {buildServerJournalDay} from './journal-day.js';
import {journalDateSchema} from './journal-protocol.js';

export async function readIdentifiedJournalDay(pool:Pool,commercialId:string,day:string) {
 z.string().uuid().parse(commercialId);journalDateSchema.parse(day);
 const db=await pool.connect();
 try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const commercial=await db.query('SELECT id,name FROM commercials WHERE id=$1 AND deleted_at IS NULL',[commercialId]);
  if(!commercial.rows.length)throw new RangeError('Commercial introuvable.');
  const invoices=await db.query(`SELECT DISTINCT ON (e.invoice_id) e.payload FROM identified_journal_events e
   JOIN identified_journal_invoices i ON i.id=e.invoice_id WHERE i.commercial_id=$1 AND i.journal_date=$2::date
   ORDER BY e.invoice_id,e.version DESC`,[commercialId,day]);
  // La vente reste dans le journal de son créateur, même modifiée par un autre commercial.
  const sales=await db.query(`WITH first AS (SELECT DISTINCT ON (sale_id) sale_id,commercial_id,journal_date FROM identified_sale_events ORDER BY sale_id,version ASC),
   latest AS (SELECT DISTINCT ON (sale_id) sale_id,payload FROM identified_sale_events ORDER BY sale_id,version DESC)
   SELECT l.sale_id AS "saleId",l.payload->'sale' AS sale FROM latest l JOIN first f ON f.sale_id=l.sale_id
   WHERE f.commercial_id=$1 AND f.journal_date=$2::date`,[commercialId,day]);
  const settlements=await db.query(`SELECT count(*)::int AS count,COALESCE(sum((payload->'settlement'->>'amount')::bigint),0)::text AS amount
   FROM identified_settlements WHERE commercial_id=$1 AND journal_date=$2::date`,[commercialId,day]);
  const closure=await db.query(`SELECT status,version,closed_at FROM tour_closures WHERE commercial_id=$1 AND journal_date=$2::date`,[commercialId,day]);
  const dayResult=buildServerJournalDay(day,invoices.rows.map(r=>r.payload),sales.rows.map(r=>({...r.sale,saleId:r.saleId})));
  const total=BigInt(dayResult.totalCollected)+BigInt(settlements.rows[0].amount);
  if(total>BigInt(Number.MAX_SAFE_INTEGER)||total<BigInt(Number.MIN_SAFE_INTEGER))throw new RangeError('Total encaissé trop élevé.');
  const state=closure.rows[0];
  await db.query('COMMIT');
  return {...dayResult,commercial:commercial.rows[0],closure:{status:state?.status??'open',version:state?.version??0,closedAt:state?.closed_at?new Date(state.closed_at).toISOString():null},
   journalCollected:dayResult.totalCollected,globalSettlementCount:settlements.rows[0].count,globalSettlementTotal:Number(settlements.rows[0].amount),totalCollected:Number(total)};
 } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
