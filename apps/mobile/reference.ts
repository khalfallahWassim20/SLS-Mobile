export type RefClient = { id: string; name: string; sector: string };
export type RefArticle = { id: string; code: string; barcode: string; name: string; saleTtc: string; vatRate: number; unitsPerCarton: number };
export type ReferenceData = { version: 1; clients: RefClient[]; articles: RefArticle[]; syncedAt: string };
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => typeof v === 'string';
/** Valider avant de remplacer le cache existant. Jamais sauvegarder de champs non prévus. */
export function validateReference(value: unknown): Omit<ReferenceData, 'syncedAt'> {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.clients) || !Array.isArray(value.articles)) throw new Error('Réponse du serveur invalide.');
  const clients = value.clients.map(v => {
    if (!record(v) || !text(v.id) || !text(v.name) || !text(v.sector)) throw new Error('Client invalide dans la réponse.');
    return { id: v.id as string, name: v.name as string, sector: v.sector as string };
  });
  const articles = value.articles.map(v => {
    if (!record(v) || !text(v.id) || !text(v.name) || !text(v.code) || !text(v.barcode) || typeof v.saleTtc !== 'string' || !/^\d+$/.test(v.saleTtc) || BigInt(v.saleTtc) > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isInteger(v.vatRate) || (v.vatRate as number) < 0 || (v.vatRate as number) > 10000 || !Number.isInteger(v.unitsPerCarton) || (v.unitsPerCarton as number) < 1) throw new Error('Article invalide dans la réponse.');
    return { id: v.id as string, name: v.name as string, code: v.code as string, barcode: v.barcode as string, saleTtc: v.saleTtc, vatRate: v.vatRate as number, unitsPerCarton: v.unitsPerCarton as number };
  });
  return { version: 1, clients, articles };
}
export function formatMillimes(value: string): string {
  const n = BigInt(value);
  return `${n / 1000n},${(n % 1000n).toString().padStart(3, '0')} DT`;
}
