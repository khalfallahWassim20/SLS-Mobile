import { summarizePreInvoice, type JournalSyncReceipt } from '@sls/domain';
export type RefClient = { id: string; name: string; sector: string; openingBalance?: string; creditLimit?: string; serverBalance?: string };
export type RefArticle = { id: string; code: string; barcode: string; name: string; saleTtc: string; vatRate: number; unitsPerCarton: number };
export type SaleState = { saleId: string; clientId: string; version: number; total: string; paid: string };
export type SettlementState = { operationId: string; clientId: string };
export type JournalState = { id:string; clientId:string; journalDate?:string; total:number; receipts:JournalSyncReceipt[] };
export type ReferenceData = { version: 1 | 2 | 3; journalStates?: JournalState[]; clients: RefClient[]; articles: RefArticle[]; saleStates?: SaleState[]; settlementStates?: SettlementState[]; syncedAt: string };
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => typeof v === 'string';
/** Valider avant de remplacer le cache existant. Jamais sauvegarder de champs non prévus. */
export function validateReference(value: unknown): Omit<ReferenceData, 'syncedAt'> {
  if (!record(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3) || !Array.isArray(value.clients) || !Array.isArray(value.articles)) throw new Error('Réponse du serveur invalide.');
  const clients = value.clients.map(v => {
    if (!record(v) || !text(v.id) || !text(v.name) || !text(v.sector)) throw new Error('Client invalide dans la réponse.');
    const amount = (x: unknown, signed: boolean) => typeof x === 'string' && (signed ? /^-?\d+$/ : /^\d+$/).test(x) && BigInt(x) <= BigInt(Number.MAX_SAFE_INTEGER) && BigInt(x) >= BigInt(Number.MIN_SAFE_INTEGER);
    // Un ancien cache reste consultable mais ne permet pas de vendre tant qu'il n'a pas été actualisé.
    if ((v.openingBalance !== undefined || v.creditLimit !== undefined) && (!amount(v.openingBalance, true) || !amount(v.creditLimit, false))) throw new Error('Solde ou plafond client invalide.');
    if (value.version !== 1 && (!amount(v.openingBalance, true) || !amount(v.creditLimit, false) || !amount(v.serverBalance, true))) throw new Error('Solde serveur invalide.');
    return { id: v.id as string, name: v.name as string, sector: v.sector as string, ...(v.openingBalance !== undefined ? { openingBalance: v.openingBalance as string, creditLimit: v.creditLimit as string } : {}), ...(value.version !== 1 ? {serverBalance: v.serverBalance as string} : {}) };
  });
  const articles = value.articles.map(v => {
    if (!record(v) || !text(v.id) || !text(v.name) || !text(v.code) || !text(v.barcode) || typeof v.saleTtc !== 'string' || !/^\d+$/.test(v.saleTtc) || BigInt(v.saleTtc) > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isInteger(v.vatRate) || (v.vatRate as number) < 0 || (v.vatRate as number) > 10000 || !Number.isInteger(v.unitsPerCarton) || (v.unitsPerCarton as number) < 1) throw new Error('Article invalide dans la réponse.');
    return { id: v.id as string, name: v.name as string, code: v.code as string, barcode: v.barcode as string, saleTtc: v.saleTtc, vatRate: v.vatRate as number, unitsPerCarton: v.unitsPerCarton as number };
  });
  if (value.version === 1) return { version: 1, clients, articles };
  if (!Array.isArray(value.saleStates) || !Array.isArray(value.settlementStates)) throw new Error('Marqueurs de synchronisation absents.');
  const clientIds = new Set(clients.map(c => c.id)), saleIds = new Set<string>(), settlementIds = new Set<string>();
  const validAmount = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER);
  const saleStates = value.saleStates.map(v => {
    if (!record(v) || !text(v.saleId) || !text(v.clientId) || !clientIds.has(v.clientId as string) || saleIds.has(v.saleId as string) || !Number.isSafeInteger(v.version) || (v.version as number) < 1 || !validAmount(v.total) || !validAmount(v.paid)) throw new Error('État de vente invalide.');
    saleIds.add(v.saleId as string);
    return { saleId: v.saleId as string, clientId: v.clientId as string, version: v.version as number, total: v.total as string, paid: v.paid as string };
  });
  const settlementStates = value.settlementStates.map(v => {
    if (!record(v) || !text(v.operationId) || !text(v.clientId) || !clientIds.has(v.clientId as string) || settlementIds.has(v.operationId as string)) throw new Error('État de règlement invalide.');
    settlementIds.add(v.operationId as string);
    return { operationId: v.operationId as string, clientId: v.clientId as string };
  });
  if (value.version === 2) return { version: 2, clients, articles, saleStates, settlementStates };
  if (!Array.isArray(value.journalStates) || clientIds.size !== clients.length) throw new Error('Marqueurs du journal absents ou clients dupliqués.');
  const invoiceIds = new Set<string>(), receiptIds = new Set<string>(), clientDays = new Set<string>();
  const journalStates = value.journalStates.map(v => {
    if (!record(v) || !text(v.id) || !v.id.trim() || !text(v.clientId) || !clientIds.has(v.clientId) || invoiceIds.has(v.id) || !Number.isSafeInteger(v.total) || (v.total as number) <= 0 || !Array.isArray(v.receipts)) throw new Error('État du journal invalide.');
    invoiceIds.add(v.id);
    if (v.journalDate !== undefined) {
      if (!isJournalDate(v.journalDate)) throw new Error('Date du journal invalide.');
      const key=JSON.stringify([v.clientId,v.journalDate]);
      if (clientDays.has(key)) throw new Error('Facture client et date dupliquée.');
      clientDays.add(key);
    }
    const receipts = v.receipts.map(p => {
      if (!record(p) || !text(p.id) || !p.id.trim() || receiptIds.has(p.id) || !Number.isSafeInteger(p.prePaid) || (p.prePaid as number) < 0 || !Number.isSafeInteger(p.oldDebtPaid) || (p.oldDebtPaid as number) < 0 || typeof p.creditFull !== 'boolean') throw new Error('Règlement du journal invalide.');
      receiptIds.add(p.id);
      return {id:p.id,prePaid:p.prePaid as number,oldDebtPaid:p.oldDebtPaid as number,creditFull:p.creditFull};
    });
    summarizePreInvoice(v.total as number,receipts);
    return {id:v.id,clientId:v.clientId,...(v.journalDate !== undefined ? {journalDate:v.journalDate as string} : {}),total:v.total as number,receipts};
  });
  return { version: 3, clients, articles, saleStates, settlementStates, journalStates };
}
function isJournalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0,10) === value;
}
/** L'état téléchargé peut être périmé hors ligne : seul le serveur tranche lors de l'envoi. */
export function preInvoiceAvailability(reference: Pick<ReferenceData,'version'|'journalStates'> | null, clientId:string, day:string, local: {clientId:string;journalDate:string}[]): 'available'|'local'|'remote'|'refresh' {
  if (local.some(p=>p.clientId===clientId && p.journalDate===day)) return 'local';
  if (reference?.version !== 3) return 'available';
  if (!reference.journalStates || reference.journalStates.some(p=>p.clientId===clientId && !p.journalDate)) return 'refresh';
  return reference.journalStates.some(p=>p.clientId===clientId && p.journalDate===day) ? 'remote' : 'available';
}
/** Signale les factures concurrentes pour ne pas additionner deux fois la dette. */
export function hasJournalDayConflict(clientId:string, local:{id:string;clientId:string;journalDate:string}[], remote:JournalState[]): boolean {
 const mine=local.filter(p=>p.clientId===clientId);
 return mine.length>0 && remote.some(r=>r.clientId===clientId && (!r.journalDate || mine.some(p=>p.journalDate===r.journalDate && p.id!==r.id)));
}
export function formatMillimes(value: string): string {
  const n = BigInt(value);
  return `${n / 1000n},${(n % 1000n).toString().padStart(3, '0')} DT`;
}

/** Conversion provisoire TTC → HT au millime le plus proche, à valider avec le comptable. */
export function unitPriceExcludingVat(saleTtc: string, vatRate: number): number {
  if (!/^\d+$/.test(saleTtc) || !Number.isInteger(vatRate) || vatRate < 0 || vatRate > 10000) throw new RangeError('Prix ou TVA invalide');
  const denom = 10000n + BigInt(vatRate);
  const result = (BigInt(saleTtc) * 10000n + denom / 2n) / denom;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Prix trop élevé');
  return Number(result);
}
