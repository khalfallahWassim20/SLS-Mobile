/** Projection expérimentale v4. Aucun routeur ne l'expose : une migration sûre reste nécessaire. */
import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {summarizePreInvoice,canonicalJson} from '@sls/domain';
import {parseJournalSnapshot,validateJournalTransition} from './journal-protocol.js';
import {lockSyncMode,assertIdentifiedMode} from './tour-sync-mode.js';
export class ReferenceOverlap extends Error {}
function unique(ids:string[],label:string) {
 const seen=new Set<string>();for(const id of ids){if(seen.has(id))throw new ReferenceOverlap(`${label} présent dans plusieurs espaces : rapprochement nécessaire.`);seen.add(id);}
}
function checked(value:bigint):string {
 if(value>BigInt(Number.MAX_SAFE_INTEGER)||value<BigInt(Number.MIN_SAFE_INTEGER))throw new RangeError('Solde trop élevé.');return value.toString();
}
/** Anciennes et nouvelles écritures partagent un instantané MVCC. En cas de recouvrement,
 * refuser toute projection plutôt que compter deux fois ou choisir arbitrairement. */
export async function readIdentifiedReference(pool:Pool,includeInactive=false,enforceMode=false) {
 const db=await pool.connect();const active=includeInactive?'':' AND c.active';
 try {
  await db.query(enforceMode?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  if(enforceMode)assertIdentifiedMode(await lockSyncMode(db));
  const clients=await db.query(`SELECT c.id,c.name,c.sector,c.opening_balance::text AS "openingBalance",c.credit_limit::text AS "creditLimit",c.opening_balance::text AS "serverBalance" FROM clients c WHERE c.deleted_at IS NULL${active} ORDER BY c.name`);
  const sales=await db.query(`WITH legacy AS (SELECT DISTINCT ON (sale_id) sale_id,client_id,version,payload FROM demo_sale_events ORDER BY sale_id,version DESC),
   identified AS (SELECT DISTINCT ON (sale_id) sale_id,client_id,version,payload FROM identified_sale_events ORDER BY sale_id,version DESC),
   combined AS (SELECT * FROM legacy UNION ALL SELECT * FROM identified)
   SELECT s.sale_id AS "saleId",s.client_id AS "clientId",s.version,s.payload->'sale'->>'total' AS total,s.payload->'sale'->>'paid' AS paid
   FROM combined s JOIN clients c ON c.id=s.client_id WHERE c.deleted_at IS NULL${active}`);
  // Deux espaces peuvent représenter la même vente seulement si le nouveau journal
  // est une continuation exacte de l'ancienne version, jamais une nouvelle vente.
  const overlaps=await db.query(`WITH legacy AS (SELECT DISTINCT ON(sale_id) sale_id,client_id,version,payload FROM demo_sale_events ORDER BY sale_id,version DESC),
   first_identified AS (SELECT DISTINCT ON(sale_id) sale_id,client_id,version,payload FROM identified_sale_events ORDER BY sale_id,version ASC)
   SELECT l.sale_id,l.client_id AS old_client,i.client_id AS new_client,l.version AS old_version,i.version AS new_version,l.payload AS old_payload,i.payload AS new_payload
   FROM legacy l JOIN first_identified i ON i.sale_id=l.sale_id`);
  for(const item of overlaps.rows) {
   const old=item.old_payload?.sale,current=item.new_payload?.sale,refund=item.new_payload?.refund;
   if(item.old_client!==item.new_client||item.new_version!==item.old_version+1||!old||!current||old.clientId!==current.clientId||old.createdAt!==current.createdAt||!Number.isSafeInteger(refund)||refund<0||current.paid!==old.paid-refund||refund>Math.max(0,old.paid-current.total))throw new ReferenceOverlap('Historique de vente incompatible : rapprochement nécessaire.');
  }
  const latestSales=new Map<string,(typeof sales.rows)[number]>();
  for(const sale of sales.rows){const prior=latestSales.get(sale.saleId);if(!prior||sale.version>prior.version)latestSales.set(sale.saleId,sale);}
  const payments=await db.query(`WITH combined AS (SELECT operation_id,client_id,payload FROM demo_settlements UNION ALL SELECT operation_id,client_id,payload FROM identified_settlements)
   SELECT p.operation_id AS "operationId",p.client_id AS "clientId",p.payload->'settlement'->>'amount' AS amount
   FROM combined p JOIN clients c ON c.id=p.client_id WHERE c.deleted_at IS NULL${active}`);
  const journals=await db.query(`WITH legacy AS (SELECT DISTINCT ON (invoice_id) invoice_id,payload FROM sync_journal_events ORDER BY invoice_id,version DESC),
   identified AS (SELECT DISTINCT ON (invoice_id) invoice_id,payload FROM identified_journal_events ORDER BY invoice_id,version DESC),
   combined AS (SELECT * FROM legacy UNION ALL SELECT * FROM identified)
   SELECT e.payload FROM combined e JOIN clients c ON c.id=(e.payload->'invoice'->>'clientId')::uuid WHERE c.deleted_at IS NULL${active}`);
  const journalOverlaps=await db.query(`WITH legacy AS (SELECT DISTINCT ON(invoice_id) invoice_id,payload FROM sync_journal_events ORDER BY invoice_id,version DESC),
   first_identified AS (SELECT DISTINCT ON(invoice_id) invoice_id,payload FROM identified_journal_events ORDER BY invoice_id,version ASC)
   SELECT l.payload AS old_payload,i.payload AS new_payload FROM legacy l JOIN first_identified i ON i.invoice_id=l.invoice_id`);
  for(const item of journalOverlaps.rows) {
   try {validateJournalTransition(parseJournalSnapshot(item.old_payload),parseJournalSnapshot(item.new_payload));}
   catch {throw new ReferenceOverlap('Historique de facture incompatible : rapprochement nécessaire.');}
  }
  const operations=await db.query(`SELECT operation_id FROM demo_sale_events UNION ALL SELECT operation_id FROM identified_sale_events UNION ALL
   SELECT operation_id FROM demo_settlements UNION ALL SELECT operation_id FROM identified_settlements UNION ALL
   SELECT operation_id FROM sync_journal_events UNION ALL SELECT operation_id FROM identified_journal_events`);
  const articles=await db.query(`SELECT id,code,barcode,name,sale_ttc::text AS "saleTtc",vat_rate AS "vatRate",units_per_carton AS "unitsPerCarton" FROM articles WHERE active AND deleted_at IS NULL ORDER BY name`);
  unique(operations.rows.map(r=>r.operation_id),'Opération');
  unique(payments.rows.map(r=>r.operationId),'Règlement');
  const latestJournals=new Map<string,ReturnType<typeof parseJournalSnapshot>>();
  for(const row of journals.rows){const event=parseJournalSnapshot(row.payload),prior=latestJournals.get(event.invoice.id);if(!prior||event.version>prior.version)latestJournals.set(event.invoice.id,event);}
  const parsed=[...latestJournals.values()];
  unique(parsed.map(e=>`${e.invoice.clientId}:${e.invoice.journalDate}`),'Facture client/jour');
  unique(parsed.flatMap(e=>e.receipts.map(r=>r.id)),'Règlement de journal');
  const byId=new Map<string,{serverBalance:string}>(clients.rows.map(c=>[c.id,c]));
  const adjust=(id:string,delta:bigint)=>{const c=byId.get(id);if(!c)throw new Error('Client introuvable.');c.serverBalance=checked(BigInt(c.serverBalance)+delta);};
  for(const sale of latestSales.values()) adjust(sale.clientId,BigInt(sale.total)-BigInt(sale.paid));
  for(const payment of payments.rows) adjust(payment.clientId,-BigInt(payment.amount));
  const journalStates=parsed.map(({invoice,receipts})=>{
   adjust(invoice.clientId,BigInt(summarizePreInvoice(invoice.amount,receipts).debtEffect));
   return {id:invoice.id,clientId:invoice.clientId,journalDate:invoice.journalDate,total:invoice.amount,receipts:receipts.map(p=>({id:p.id,prePaid:p.prePaid,oldDebtPaid:p.oldDebtPaid,creditFull:p.creditFull}))};
  });
  const journalProofs=parsed.map(snapshot=>({id:snapshot.invoice.id,version:snapshot.version,hash:createHash('sha256').update(canonicalJson(snapshot)).digest('hex')}));
  await db.query('COMMIT');
  return {version:4 as const,clients:clients.rows,articles:articles.rows,saleStates:[...latestSales.values()],settlementStates:payments.rows.map(({operationId,clientId})=>({operationId,clientId})),journalStates,journalProofs};
 } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
