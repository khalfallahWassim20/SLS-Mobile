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
