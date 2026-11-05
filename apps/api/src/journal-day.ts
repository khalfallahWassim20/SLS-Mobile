import type { Pool } from 'pg';
import { z } from 'zod';
import { summarizePreInvoice } from '@sls/domain';
import { journalDateSchema, parseJournalSnapshot, type JournalSnapshot } from './journal-protocol.js';

const saleSchema = z.object({
  clientId:z.string().uuid(), clientName:z.string().min(1).max(200),
  total:z.number().int().safe().nonnegative(), paid:z.number().int().safe().nonnegative()
}).passthrough();
type Sale = z.infer<typeof saleSchema> & { saleId: string };
const safe = (n: bigint): number => {
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError('Total du journal trop élevé.');
  return Number(n);
};
/** Agrégation sur versions reçues uniquement, pas un chiffre d'affaires consolidé. */
export function buildServerJournalDay(day: string, invoices: JournalSnapshot[], sales: Sale[]) {
  journalDateSchema.parse(day);
  const rows = new Map<string, {clientId:string;clientName:string;sector:string;preInvoiceId:string|null;preInvoiceTotal:bigint;preInvoicePaid:bigint;oldDebtPaid:bigint;preInvoiceRemaining:bigint;declared:boolean;tourTotal:bigint;tourPaid:bigint;saleCount:number}>();
  const row = (clientId:string,clientName:string,sector:string) => {
    let r=rows.get(clientId);
    if (!r) {r={clientId,clientName,sector,preInvoiceId:null,preInvoiceTotal:0n,preInvoicePaid:0n,oldDebtPaid:0n,preInvoiceRemaining:0n,declared:false,tourTotal:0n,tourPaid:0n,saleCount:0};rows.set(clientId,r);}
    return r;
  };
  for (const raw of invoices) {
    const event=parseJournalSnapshot(raw), p=event.invoice;
    if (p.journalDate!==day) throw new RangeError('Facture d’un autre jour.');
    const r=row(p.clientId,p.clientName,p.sector);
    if (r.preInvoiceId) throw new RangeError('Facture préétablie dupliquée.');
    const totals=summarizePreInvoice(p.amount,event.receipts);
    r.preInvoiceId=p.id; r.preInvoiceTotal=BigInt(p.amount);r.preInvoicePaid=BigInt(totals.prePaid);r.oldDebtPaid=BigInt(totals.oldDebtPaid);r.preInvoiceRemaining=BigInt(totals.remaining);r.declared=totals.declared;
  }
  const ids=new Set<string>();
  for(const input of sales) {
    const sale=saleSchema.parse(input);
    if (!input.saleId || ids.has(input.saleId)) throw new RangeError('Vente dupliquée.');
    ids.add(input.saleId);
    const r=row(sale.clientId,sale.clientName,'');r.tourTotal+=BigInt(sale.total);r.tourPaid+=BigInt(sale.paid);r.saleCount++;
  }
  const result=[...rows.values()].map(r => ({clientId:r.clientId,clientName:r.clientName,sector:r.sector,preInvoiceId:r.preInvoiceId,
    preInvoiceTotal:safe(r.preInvoiceTotal), preInvoicePaid:safe(r.preInvoicePaid), oldDebtPaid:safe(r.oldDebtPaid), preInvoiceRemaining:safe(r.preInvoiceRemaining), declared:r.declared,
    tourTotal:safe(r.tourTotal),tourPaid:safe(r.tourPaid), saleCount:r.saleCount, totalClient:safe(r.preInvoiceTotal+r.tourTotal), totalCollected:safe(r.preInvoicePaid+r.oldDebtPaid+r.tourPaid)})).sort((a,b)=>a.clientName.localeCompare(b.clientName));
  return {day,rows:result,clientCount:result.length,totalBilled:safe(result.reduce((n,r)=>n+BigInt(r.totalClient),0n)),totalCollected:safe(result.reduce((n,r)=>n+BigInt(r.totalCollected),0n))};
}
/** Les deux requêtes partagent un instantané MVCC, sans effet sur les soldes. */
export async function readServerJournalDay(pool: Pool, day: string, namespace: 'experimental'|'sync' = 'experimental') {
  const prefix=namespace==='sync'?'sync_journal':'demo_journal';
  journalDateSchema.parse(day);
  const db=await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const invoices=await db.query(`SELECT DISTINCT ON (e.invoice_id) e.payload
      FROM ${prefix}_events e JOIN ${prefix}_invoices i ON i.id=e.invoice_id
      WHERE i.journal_date=$1::date ORDER BY e.invoice_id,e.version DESC`,[day]);
    const sales=await db.query(`WITH latest AS (SELECT DISTINCT ON (sale_id) sale_id,payload FROM demo_sale_events ORDER BY sale_id,version DESC)
      SELECT sale_id AS "saleId",payload->'sale' AS sale FROM latest
      WHERE ((payload->'sale'->>'createdAt')::timestamptz AT TIME ZONE 'Africa/Tunis')::date=$1::date`,[day]);
    const result=buildServerJournalDay(day,invoices.rows.map(r=>r.payload),sales.rows.map(r=>({...r.sale,saleId:r.saleId})));
    await db.query('COMMIT'); return result;
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
