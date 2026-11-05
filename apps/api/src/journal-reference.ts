/** Préparation de la référence mobile v3 ; aucune route ne l'expose encore. */
import type { Pool } from 'pg';
import { summarizePreInvoice } from '@sls/domain';
import { parseJournalSnapshot } from './journal-protocol.js';

/** Les soldes et tous leurs marqueurs doivent être lus dans le même instantané PostgreSQL. */
export async function readJournalReference(pool: Pool) {
 const db=await pool.connect();
 try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const clients=await db.query(`WITH latest AS (
    SELECT DISTINCT ON (sale_id) client_id,payload FROM demo_sale_events ORDER BY sale_id,version DESC
  ), sales AS (SELECT client_id,sum((payload->'sale'->>'total')::bigint-(payload->'sale'->>'paid')::bigint) AS balance FROM latest GROUP BY client_id),
  payments AS (SELECT client_id,sum((payload->'settlement'->>'amount')::bigint) AS total FROM demo_settlements GROUP BY client_id)
  SELECT c.id,c.name,c.sector,c.opening_balance::text AS "openingBalance",c.credit_limit::text AS "creditLimit",
  (c.opening_balance+COALESCE(s.balance,0)-COALESCE(p.total,0))::text AS "serverBalance"
  FROM clients c LEFT JOIN sales s ON s.client_id=c.id LEFT JOIN payments p ON p.client_id=c.id
  WHERE c.active AND c.deleted_at IS NULL ORDER BY c.name`);
  const saleStates=await db.query(`SELECT DISTINCT ON (e.sale_id) e.sale_id AS "saleId",e.client_id AS "clientId",e.version,
    e.payload->'sale'->>'total' AS total,e.payload->'sale'->>'paid' AS paid FROM demo_sale_events e JOIN clients c ON c.id=e.client_id
    WHERE c.active AND c.deleted_at IS NULL ORDER BY e.sale_id,e.version DESC`);
  const settlementStates=await db.query(`SELECT p.operation_id AS "operationId",p.client_id AS "clientId" FROM demo_settlements p JOIN clients c ON c.id=p.client_id WHERE c.active AND c.deleted_at IS NULL`);
  const articles=await db.query(`SELECT id,code,barcode,name,sale_ttc::text AS "saleTtc",vat_rate AS "vatRate",units_per_carton AS "unitsPerCarton" FROM articles WHERE active AND deleted_at IS NULL ORDER BY name`);
  const journals=await db.query(`SELECT DISTINCT ON (e.invoice_id) e.payload FROM sync_journal_events e
    JOIN sync_journal_invoices i ON i.id=e.invoice_id JOIN clients c ON c.id=i.client_id
    WHERE c.active AND c.deleted_at IS NULL ORDER BY e.invoice_id,e.version DESC`);
  const clientMap=new Map<string,{serverBalance:string}>(clients.rows.map(c=>[c.id,c]));
  const journalStates=journals.rows.map(r=>{
    const event=parseJournalSnapshot(r.payload), {invoice,receipts}=event;
    const c=clientMap.get(invoice.clientId); if(!c) throw new Error('Client journal introuvable.');
    const effect=summarizePreInvoice(invoice.amount,receipts).debtEffect;
    const balance=BigInt(c.serverBalance)+BigInt(effect);
    if(balance>BigInt(Number.MAX_SAFE_INTEGER)||balance<BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError('Solde trop élevé.');
    c.serverBalance=balance.toString();
    return {id:invoice.id,clientId:invoice.clientId,total:invoice.amount,receipts:receipts.map(p=>({id:p.id,prePaid:p.prePaid,oldDebtPaid:p.oldDebtPaid,creditFull:p.creditFull}))};
  });
  await db.query('COMMIT');
  return {version:3 as const,clients:clients.rows,articles:articles.rows,saleStates:saleStates.rows,settlementStates:settlementStates.rows,journalStates};
 } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
