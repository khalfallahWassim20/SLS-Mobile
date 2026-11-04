import * as SQLite from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { bootstrapJournalQueue, journalQueueSchema, queueJournalSnapshot } from './journal-queue';

export type SavedSale = {
  id: number; createdAt: string; clientId: string; clientName: string; syncSaleId?: string; syncVersion?: number;
  lines: { name: string; code: string; quantity: number; unitPrice: number; discount: number; vat: number }[];
  total: number; paid: number; remaining: number; paymentMode: string;
  chequeNumber: string; chequeBank: string; chequeDue: string;
};
let database: Promise<SQLite.SQLiteDatabase> | undefined;
async function db() {
  if (!database) database = SQLite.openDatabaseAsync('sls-demo.db').then(async instance => {
    await instance.execAsync(`PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
      client_id TEXT NOT NULL, payload TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS sale_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL, created_at TEXT NOT NULL,
      previous_payload TEXT NOT NULL, new_payload TEXT NOT NULL, refund INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, client_id TEXT NOT NULL, payload TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS sales_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, sale_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, last_error TEXT
    ); CREATE TABLE IF NOT EXISTS tour_pre_invoices (
      id TEXT PRIMARY KEY, journal_date TEXT NOT NULL, client_id TEXT NOT NULL,
      payload TEXT NOT NULL, UNIQUE(journal_date, client_id)
    ); CREATE TABLE IF NOT EXISTS tour_journal_receipts (
      id TEXT PRIMARY KEY, pre_invoice_id TEXT NOT NULL, client_id TEXT NOT NULL, journal_date TEXT NOT NULL, payload TEXT NOT NULL
    ); ${journalQueueSchema}`);
    return instance;
  }).catch(error => { database = undefined; throw error; });
  return database;
}
export async function getSales(): Promise<SavedSale[]> {
  const rows = await (await db()).getAllAsync<{ id: number; payload: string }>('SELECT id, payload FROM sales ORDER BY id DESC');
  return rows.map(row => ({ ...JSON.parse(row.payload), id: row.id } as SavedSale));
}
export async function saveSale(sale: Omit<SavedSale, 'id'>, syncEligible = false): Promise<void> {
  const database = await db();
  await database.withExclusiveTransactionAsync(async tx => {
    const snapshot = syncEligible ? { ...sale, syncSaleId: randomUUID(), syncVersion: 1 } : sale;
    await tx.runAsync('INSERT INTO sales (created_at, client_id, payload) VALUES (?, ?, ?)', snapshot.createdAt, snapshot.clientId, JSON.stringify(snapshot));
    if (snapshot.syncSaleId) {
      const operationId = randomUUID();
      const event = { operationId, saleId: snapshot.syncSaleId, version: 1, sale: snapshot, refund: 0 };
      await tx.runAsync('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)', operationId, snapshot.syncSaleId, 1, JSON.stringify(event));
    }
  });
}

export type Revision = { id: number; createdAt: string; previous: SavedSale; current: SavedSale; refund: number };
export async function getRevisions(saleId: number): Promise<Revision[]> {
  const rows = await (await db()).getAllAsync<{id: number; created_at: string; previous_payload: string; new_payload: string; refund: number}>(
    'SELECT id, created_at, previous_payload, new_payload, refund FROM sale_revisions WHERE sale_id = ? ORDER BY id DESC', saleId);
  return rows.map(r => ({ id: r.id, createdAt: r.created_at, previous: JSON.parse(r.previous_payload), current: JSON.parse(r.new_payload), refund: r.refund }));
}
export async function updateSale(previous: SavedSale, updated: SavedSale, refund: number): Promise<void> {
  const database = await db();
  await database.withExclusiveTransactionAsync(async tx => {
    const row = await tx.getFirstAsync<{payload: string}>('SELECT payload FROM sales WHERE id = ?', previous.id);
    if (!row || JSON.stringify({ ...JSON.parse(row.payload), id: previous.id }) !== JSON.stringify(previous)) throw new Error('La vente a changé. Veuillez rouvrir son détail.');
    const { id: _id, ...originalPayload } = updated;
    const payload = previous.syncSaleId ? { ...originalPayload, syncVersion: (previous.syncVersion ?? 1) + 1 } : originalPayload;
    const json = JSON.stringify(payload);
    await tx.runAsync('UPDATE sales SET payload = ? WHERE id = ?', json, previous.id);
    const persisted = { ...payload, id: previous.id };
    await tx.runAsync('INSERT INTO sale_revisions (sale_id, created_at, previous_payload, new_payload, refund) VALUES (?, ?, ?, ?, ?)', previous.id, new Date().toISOString(), JSON.stringify(previous), JSON.stringify(persisted), refund);
    if (previous.syncSaleId) {
      const operationId = randomUUID();
      const event = { operationId, saleId: previous.syncSaleId, version: payload.syncVersion, sale: payload, refund };
      await tx.runAsync('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)', operationId, previous.syncSaleId, payload.syncVersion!, JSON.stringify(event));
    }
  });
}

export type Settlement = { id: number; syncOperationId?: string; createdAt: string; clientId: string; clientName: string; amount: number; mode: string; chequeNumber: string; chequeBank: string; chequeDue: string };
export async function getSettlements(): Promise<Settlement[]> {
  const rows = await (await db()).getAllAsync<{id: number; payload: string}>('SELECT id, payload FROM settlements ORDER BY id DESC');
  return rows.map(r => ({ ...JSON.parse(r.payload), id: r.id }));
}
export async function saveSettlement(settlement: Omit<Settlement, 'id'>, syncEligible = false): Promise<void> {
  const database = await db();
  await database.withExclusiveTransactionAsync(async tx => {
    const syncOperationId = syncEligible ? randomUUID() : undefined;
    const snapshot = syncOperationId ? { ...settlement, syncOperationId } : settlement;
    await tx.runAsync('INSERT INTO settlements (created_at, client_id, payload) VALUES (?, ?, ?)', snapshot.createdAt, snapshot.clientId, JSON.stringify(snapshot));
    if (syncOperationId) {
      const event = { operationId: syncOperationId, settlement: snapshot };
      await tx.runAsync('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)', syncOperationId, syncOperationId, 1, JSON.stringify(event));
    }
  });
}
// La première version sauvegardée de chaque vente conserve le paiement initial,
// y compris après remboursement. Pour une vente non modifiée, le payload actuel suffit.
export async function getOriginalSales(): Promise<SavedSale[]> {
  const rows = await (await db()).getAllAsync<{id: number; payload: string}>(`SELECT s.id, COALESCE(
    (SELECT r.previous_payload FROM sale_revisions r WHERE r.sale_id = s.id ORDER BY r.id ASC LIMIT 1), s.payload
  ) AS payload FROM sales s`);
  return rows.map(r => ({ ...JSON.parse(r.payload), id: r.id }));
}

// Un seul instantané complet : une panne avant le commit conserve l'ancien.
export async function saveReference(payload: string): Promise<void> {
  const database = await db();
  await database.execAsync('CREATE TABLE IF NOT EXISTS reference_snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL)');
  await database.runAsync('INSERT INTO reference_snapshot (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', payload);
}
export async function getReference(): Promise<string | null> {
  const database = await db();
  await database.execAsync('CREATE TABLE IF NOT EXISTS reference_snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL)');
  const row = await database.getFirstAsync<{ payload: string }>('SELECT payload FROM reference_snapshot WHERE id=1');
  return row?.payload ?? null;
}

export type OutboxEntry = { sequence: number; operationId: string; saleId: string; version: number; payload: string; lastError: string | null };
export async function getOutbox(): Promise<OutboxEntry[]> {
 return (await db()).getAllAsync<OutboxEntry>('SELECT sequence, operation_id AS operationId, sale_id AS saleId, version, payload, last_error AS lastError FROM sales_outbox ORDER BY sequence');
}
export async function acknowledgeOutbox(operationId: string): Promise<void> {
 await (await db()).runAsync('DELETE FROM sales_outbox WHERE operation_id = ?', operationId);
}
export async function failOutbox(operationId: string, error: string): Promise<void> {
 await (await db()).runAsync('UPDATE sales_outbox SET last_error = ? WHERE operation_id = ?', error.slice(0, 300), operationId);
}

export type TourPreInvoice = { id: string; journalDate: string; clientId: string; clientName: string; sector: string; amount: number; createdAt: string };
export async function getPreInvoices(journalDate: string): Promise<TourPreInvoice[]> {
 const database = await db();
 await database.execAsync(`CREATE TABLE IF NOT EXISTS tour_pre_invoices (
   id TEXT PRIMARY KEY, journal_date TEXT NOT NULL, client_id TEXT NOT NULL,
   payload TEXT NOT NULL, UNIQUE(journal_date, client_id)
 )`);
 const rows = await database.getAllAsync<{payload: string}>('SELECT payload FROM tour_pre_invoices WHERE journal_date = ? ORDER BY rowid', journalDate);
 return rows.map(row => JSON.parse(row.payload));
}
export async function savePreInvoice(value: Omit<TourPreInvoice, 'id'>): Promise<void> {
 if (!value.clientId || !value.clientName || !Number.isSafeInteger(value.amount) || value.amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(value.journalDate)) throw new Error('Saisie invalide.');
 const database = await db();
 await getPreInvoices(value.journalDate); // initialise la table avant l'écriture
 const id = randomUUID(), payload = { ...value, id };
 try { await database.withExclusiveTransactionAsync(async tx => {
   await tx.runAsync('INSERT INTO tour_pre_invoices (id,journal_date,client_id,payload) VALUES (?,?,?,?)', id, value.journalDate, value.clientId, JSON.stringify(payload));
   await queueJournalSnapshot(tx,id,randomUUID);
 }); }
 catch (error) {
   const existing = await database.getFirstAsync<{id: string}>('SELECT id FROM tour_pre_invoices WHERE journal_date=? AND client_id=?', value.journalDate, value.clientId);
   if (existing) throw new Error('Une facture préétablie existe déjà pour ce client aujourd’hui.');
   throw error;
 }
}

export type TourJournalReceipt = { id: string; preInvoiceId: string; clientId: string; journalDate: string; createdAt: string; prePaid: number; oldDebtPaid: number; creditFull: boolean; mode: 'Espèces' | 'Chèque' | 'Virement'; chequeNumber: string; chequeBank: string; chequeDue: string; oldDebtLimitAtStart: number };
async function ensureJournalReceipts() {
 const database = await db();
 await database.execAsync(`CREATE TABLE IF NOT EXISTS tour_journal_receipts (
   id TEXT PRIMARY KEY, pre_invoice_id TEXT NOT NULL, client_id TEXT NOT NULL, journal_date TEXT NOT NULL, payload TEXT NOT NULL
 )`);
 return database;
}
export async function getAllPreInvoices(): Promise<TourPreInvoice[]> {
 const database = await db();
 await database.withExclusiveTransactionAsync(async tx => { await bootstrapJournalQueue(tx,randomUUID); });
 const rows = await database.getAllAsync<{payload:string}>('SELECT payload FROM tour_pre_invoices ORDER BY rowid');
 return rows.map(r => JSON.parse(r.payload));
}
export async function getTourReceipts(): Promise<TourJournalReceipt[]> {
 const database = await ensureJournalReceipts();
 const rows = await database.getAllAsync<{payload:string}>('SELECT payload FROM tour_journal_receipts ORDER BY rowid');
 return rows.map(r => JSON.parse(r.payload));
}
export async function saveTourReceipt(value: Omit<TourJournalReceipt,'id'>, availableOldDebt: number): Promise<void> {
 const { validatePreInvoiceReceipt } = await import('@sls/domain');
 const database = await ensureJournalReceipts();
 await database.withExclusiveTransactionAsync(async tx => {
   const raw = await tx.getFirstAsync<{payload:string}>('SELECT payload FROM tour_pre_invoices WHERE id=? AND client_id=? AND journal_date=?', value.preInvoiceId, value.clientId, value.journalDate);
   if (!raw) throw new Error('Facture préétablie introuvable.');
   const invoice: TourPreInvoice = JSON.parse(raw.payload);
   const previousRows = await tx.getAllAsync<{payload:string}>('SELECT payload FROM tour_journal_receipts WHERE pre_invoice_id=? ORDER BY rowid', value.preInvoiceId);
   const previous: TourJournalReceipt[] = previousRows.map(r => JSON.parse(r.payload));
   if (previous.length && value.oldDebtLimitAtStart !== previous[0].oldDebtLimitAtStart) throw new Error('Ancienne dette incohérente.');
   if (!Number.isSafeInteger(value.oldDebtLimitAtStart) || value.oldDebtLimitAtStart < 0) throw new Error('Ancienne dette invalide.');
   const priorDebtPaid = previous.reduce((n,p) => n+p.oldDebtPaid, 0);
   const bound = Math.min(availableOldDebt, Math.max(0,value.oldDebtLimitAtStart-priorDebtPaid));
   if (!['Espèces','Chèque','Virement'].includes(value.mode)) throw new Error('Mode de paiement invalide.');
   if (value.mode === 'Chèque' && (value.prePaid || value.oldDebtPaid) && (!value.chequeNumber.trim() || !value.chequeBank.trim() || !value.chequeDue.trim())) throw new Error('Renseignez le numéro, la banque et l’échéance du chèque.');
   validatePreInvoiceReceipt(invoice.amount, previous, value, bound);
   const state = await tx.getFirstAsync<{version:number}>('SELECT version FROM journal_sync_state WHERE invoice_id=?', value.preInvoiceId);
   if (!state) await queueJournalSnapshot(tx,value.preInvoiceId,randomUUID);
   const id = randomUUID();
   await tx.runAsync('INSERT INTO tour_journal_receipts(id,pre_invoice_id,client_id,journal_date,payload) VALUES (?,?,?,?,?)', id,value.preInvoiceId,value.clientId,value.journalDate,JSON.stringify({...value,id}));
   await queueJournalSnapshot(tx,value.preInvoiceId,randomUUID);
 });
}
