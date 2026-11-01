import * as SQLite from 'expo-sqlite';

export type SavedSale = {
  id: number; createdAt: string; clientId: string; clientName: string;
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
    );`);
    return instance;
  }).catch(error => { database = undefined; throw error; });
  return database;
}
export async function getSales(): Promise<SavedSale[]> {
  const rows = await (await db()).getAllAsync<{ id: number; payload: string }>('SELECT id, payload FROM sales ORDER BY id DESC');
  return rows.map(row => ({ ...JSON.parse(row.payload), id: row.id } as SavedSale));
}
export async function saveSale(sale: Omit<SavedSale, 'id'>): Promise<void> {
  await (await db()).runAsync('INSERT INTO sales (created_at, client_id, payload) VALUES (?, ?, ?)', sale.createdAt, sale.clientId, JSON.stringify(sale));
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
    const { id: _id, ...payload } = updated;
    const json = JSON.stringify(payload);
    await tx.runAsync('UPDATE sales SET payload = ? WHERE id = ?', json, previous.id);
    await tx.runAsync('INSERT INTO sale_revisions (sale_id, created_at, previous_payload, new_payload, refund) VALUES (?, ?, ?, ?, ?)', previous.id, new Date().toISOString(), JSON.stringify(previous), JSON.stringify(updated), refund);
  });
}

export type Settlement = { id: number; createdAt: string; clientId: string; clientName: string; amount: number; mode: string; chequeNumber: string; chequeBank: string; chequeDue: string };
export async function getSettlements(): Promise<Settlement[]> {
  const rows = await (await db()).getAllAsync<{id: number; payload: string}>('SELECT id, payload FROM settlements ORDER BY id DESC');
  return rows.map(r => ({ ...JSON.parse(r.payload), id: r.id }));
}
export async function saveSettlement(settlement: Omit<Settlement, 'id'>): Promise<void> {
  await (await db()).runAsync('INSERT INTO settlements (created_at, client_id, payload) VALUES (?, ?, ?)', settlement.createdAt, settlement.clientId, JSON.stringify(settlement));
}
// La première version sauvegardée de chaque vente conserve le paiement initial,
// y compris après remboursement. Pour une vente non modifiée, le payload actuel suffit.
export async function getOriginalSales(): Promise<SavedSale[]> {
  const rows = await (await db()).getAllAsync<{id: number; payload: string}>(`SELECT s.id, COALESCE(
    (SELECT r.previous_payload FROM sale_revisions r WHERE r.sale_id = s.id ORDER BY r.id ASC LIMIT 1), s.payload
  ) AS payload FROM sales s`);
  return rows.map(r => ({ ...JSON.parse(r.payload), id: r.id }));
}
