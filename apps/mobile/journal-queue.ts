/** Préparation locale de la synchronisation du journal. Aucun envoi réseau ici. */
import type { TourPreInvoice, TourJournalReceipt } from './storage';

type Bind = string | number | null;
export type QueueTransaction = {
  getAllAsync<T>(sql: string, ...params: Bind[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, ...params: Bind[]): Promise<T | null>;
  runAsync(sql: string, ...params: Bind[]): Promise<unknown>;
};
export const journalQueueSchema = `
  CREATE TABLE IF NOT EXISTS journal_sync_state (
    invoice_id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version > 0), payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS journal_sync_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
    invoice_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), payload TEXT NOT NULL,
    UNIQUE(invoice_id,version)
  );`;

type Snapshot = { operationId:string; version:number; invoice:TourPreInvoice; receipts:TourJournalReceipt[] };
/** Exécuter à l'intérieur de la même transaction que l'écriture de la facture/du règlement. */
export async function queueJournalSnapshot(tx: QueueTransaction, invoiceId: string, uuid: () => string): Promise<string> {
  const invoiceRow = await tx.getFirstAsync<{payload:string}>('SELECT payload FROM tour_pre_invoices WHERE id=?',invoiceId);
  if (!invoiceRow) throw new Error('Facture introuvable pour la file du journal.');
  const invoice: TourPreInvoice = JSON.parse(invoiceRow.payload);
  const receiptRows = await tx.getAllAsync<{payload:string}>('SELECT payload FROM tour_journal_receipts WHERE pre_invoice_id=? ORDER BY rowid',invoiceId);
  const receipts: TourJournalReceipt[] = receiptRows.map(r => JSON.parse(r.payload));
  const state = await tx.getFirstAsync<{version:number;payload:string}>('SELECT version,payload FROM journal_sync_state WHERE invoice_id=?',invoiceId);
  if (state) {
    const old: Snapshot = JSON.parse(state.payload);
    if (old.version !== state.version || JSON.stringify(old.invoice) !== JSON.stringify(invoice) || receipts.length !== old.receipts.length+1 || old.receipts.some((receipt,index)=>JSON.stringify(receipt)!==JSON.stringify(receipts[index]))) throw new Error('Historique local du journal incohérent.');
  }
  const version = (state?.version ?? 0) + 1;
  if (!Number.isSafeInteger(version) || version > 1000000) throw new Error('Trop de versions du journal.');
  const operationId=uuid(), snapshot: Snapshot={operationId,version,invoice,receipts};
  const payload=JSON.stringify(snapshot);
  await tx.runAsync('INSERT INTO journal_sync_outbox(operation_id,invoice_id,version,payload) VALUES(?,?,?,?)',operationId,invoiceId,version,payload);
  await tx.runAsync('INSERT INTO journal_sync_state(invoice_id,version,payload) VALUES(?,?,?) ON CONFLICT(invoice_id) DO UPDATE SET version=excluded.version,payload=excluded.payload',invoiceId,version,payload);
  return operationId;
}
/** Prépare une première version de chaque facture créée avant la file, sans effacer l'historique.
 * À exécuter en transaction ; relançable et sans doublon. */
export async function bootstrapJournalQueue(tx: QueueTransaction, uuid: () => string): Promise<void> {
  const missing=await tx.getAllAsync<{id:string}>(`SELECT p.id FROM tour_pre_invoices p LEFT JOIN journal_sync_state s ON s.invoice_id=p.id WHERE s.invoice_id IS NULL ORDER BY p.rowid`);
  for (const row of missing) await queueJournalSnapshot(tx,row.id,uuid);
}
