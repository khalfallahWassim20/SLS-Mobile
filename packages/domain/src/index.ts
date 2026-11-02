/** Montants en millimes ; taux en centièmes de pour cent (19 % = 1900). */
export type InvoiceLine = { quantity: number; unitPrice: number; discountRate: number; vatRate: number };
export type InvoiceTotals = { subtotal: number; discount: number; net: number; vat: number; stamp: number; total: number; vatByRate: { rate: number; base: number; vat: number }[] };

function integer(value: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} invalide`);
}
function safe(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError('Montant trop élevé');
  return Number(value);
}
// Arrondi au millime le plus proche, moitié supérieure, pour les montants positifs.
function roundRatio(value: bigint, numerator: number, denominator = 10000n): bigint {
  return (value * BigInt(numerator) + denominator / 2n) / denominator;
}

export function calculateInvoice(lines: InvoiceLine[], stamp = 0): InvoiceTotals {
  if (!lines.length) throw new RangeError('Une facture doit comporter au moins une ligne');
  integer(stamp, 'Timbre');
  let subtotal = 0n, discount = 0n;
  const bases = new Map<number, bigint>();
  for (const line of lines) {
    integer(line.quantity, 'Quantité', 1);
    integer(line.unitPrice, 'Prix');
    integer(line.discountRate, 'Remise', 0, 10000);
    integer(line.vatRate, 'TVA', 0, 10000);
    const gross = BigInt(line.quantity) * BigInt(line.unitPrice);
    // Arrondir le montant net de chaque ligne, puis calculer la TVA par taux.
    const net = roundRatio(gross, 10000 - line.discountRate);
    subtotal += gross;
    discount += gross - net;
    bases.set(line.vatRate, (bases.get(line.vatRate) ?? 0n) + net);
  }
  const vatByRate = [...bases.entries()].sort(([a], [b]) => a - b).map(([rate, base]) => ({ rate, base: safe(base), vat: safe(roundRatio(base, rate)) }));
  const net = subtotal - discount;
  const vat = vatByRate.reduce((sum, group) => sum + BigInt(group.vat), 0n);
  return { subtotal: safe(subtotal), discount: safe(discount), net: safe(net), vat: safe(vat), stamp, total: safe(net + vat + BigInt(stamp)), vatByRate };
}

/** Solde signé : positif = dette du client, négatif = crédit en sa faveur.
 * Les totaux et paiements doivent représenter la même facture avant/après modification.
 * Le remboursement est une sortie d'argent réelle, enregistrée séparément.
 */
export function balanceAfterInvoiceChange(input: { balance: number; oldTotal: number; oldPaid: number; newTotal: number; newPaid: number; refund: number }): number {
  integer(input.balance, 'Solde', Number.MIN_SAFE_INTEGER);
  for (const [name, value] of Object.entries(input)) if (name !== 'balance') integer(value, name);
  const overpayment = Math.max(0, input.newPaid - input.newTotal);
  if (input.refund > overpayment) throw new RangeError('Remboursement supérieur au trop-perçu');
  return safe(BigInt(input.balance) - (BigInt(input.oldTotal) - BigInt(input.oldPaid)) + (BigInt(input.newTotal) - BigInt(input.newPaid) + BigInt(input.refund)));
}

/** Décision locale basée sur le solde connu ; une autorisation admin doit être synchronisée. */
export function isSaleBlocked(balance: number, creditLimit: number, adminOverride: boolean): boolean {
  integer(balance, 'Solde', Number.MIN_SAFE_INTEGER);
  integer(creditLimit, 'Plafond');
  return !adminOverride && creditLimit > 0 && balance >= creditLimit;
}

/** Saisie en dinars (virgule ou point), convertie sans flottants en millimes. */
export function parseDinars(value: string): number {
  const match = /^(\d+)(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (!match) throw new RangeError('Saisissez un montant positif avec au maximum 3 décimales');
  return safe(BigInt(match[1]) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0')));
}

export function calculatePayment(total: number, paid: number): { paid: number; remaining: number } {
  integer(total, 'Total'); integer(paid, 'Paiement');
  if (paid > total) throw new RangeError('Le montant encaissé ne peut pas dépasser le total');
  return { paid, remaining: total - paid };
}

/** Révision d'une vente : un remboursement diminue les paiements nets conservés. */
export function revisePayment(total: number, paid: number, disposition?: 'refund' | 'credit') {
  integer(total, 'Total'); integer(paid, 'Paiement');
  const excess = Math.max(0, paid - total);
  if (excess && disposition !== 'refund' && disposition !== 'credit') throw new RangeError('Choisissez le remboursement ou le crédit client');
  const refund = disposition === 'refund' ? excess : 0;
  const netPaid = paid - refund;
  return { paid: netPaid, refund, remaining: Math.max(0, total - netPaid), credit: Math.max(0, netPaid - total), balanceContribution: total - netPaid };
}

/** Solde initial et contributions des ventes : dette positive, crédit négatif. */
export function calculateClientBalance(openingBalance: number, sales: { total: number; paid: number }[]): number {
  integer(openingBalance, 'Solde initial', Number.MIN_SAFE_INTEGER);
  let balance = BigInt(openingBalance);
  for (const sale of sales) {
    integer(sale.total, 'Total'); integer(sale.paid, 'Paiement net');
    balance += BigInt(sale.total) - BigInt(sale.paid);
  }
  return safe(balance);
}

/** Règlement global non imputé à une facture ; pas de trop-perçu à la saisie. */
export function balanceAfterSettlement(balance: number, payment: number): number {
  integer(balance, 'Solde', Number.MIN_SAFE_INTEGER);
  integer(payment, 'Règlement', 1);
  if (balance <= 0 || payment > balance) throw new RangeError('Le règlement doit être positif et ne pas dépasser la dette du client');
  return balance - payment;
}

/** Fusionne un instantané serveur et les opérations locales sans double comptage.
 * Le booléen conflict signale une version locale incohérente ou plus ancienne.
 */
export function reconcileClientBalance(input: {
  serverBalance: number;
  localSales: { syncSaleId?: string; syncVersion?: number; total: number; paid: number }[];
  serverSales: { saleId: string; version: number; total: number; paid: number }[];
  localSettlements: { syncOperationId?: string; amount: number }[];
  serverSettlementIds: string[];
}): { balance: number; conflict: boolean } {
  integer(input.serverBalance, 'Solde serveur', Number.MIN_SAFE_INTEGER);
  let balance = BigInt(input.serverBalance), conflict = false;
  const remote = new Map<string, typeof input.serverSales[number]>();
  for (const s of input.serverSales) {
    integer(s.version, 'Version serveur', 1); integer(s.total, 'Total serveur'); integer(s.paid, 'Paiement serveur');
    if (remote.has(s.saleId)) throw new RangeError('Vente serveur dupliquée');
    remote.set(s.saleId, s);
  }
  const localIds = new Set<string>();
  for (const sale of input.localSales) {
    integer(sale.total, 'Total local'); integer(sale.paid, 'Paiement local');
    if (sale.syncSaleId) {
      integer(sale.syncVersion ?? 0, 'Version locale', 1);
      if (localIds.has(sale.syncSaleId)) throw new RangeError('Vente locale dupliquée');
      localIds.add(sale.syncSaleId);
    }
    const server = sale.syncSaleId ? remote.get(sale.syncSaleId) : undefined;
    if (!server) balance += BigInt(sale.total) - BigInt(sale.paid);
    else if (sale.syncVersion! > server.version) balance += BigInt(sale.total) - BigInt(sale.paid) - BigInt(server.total) + BigInt(server.paid);
    else if (sale.syncVersion! < server.version || sale.total !== server.total || sale.paid !== server.paid) conflict = true;
  }
  const settled = new Set(input.serverSettlementIds), localSettlementIds = new Set<string>();
  for (const payment of input.localSettlements) {
    integer(payment.amount, 'Règlement local', 1);
    if (payment.syncOperationId) {
      if (localSettlementIds.has(payment.syncOperationId)) throw new RangeError('Règlement local dupliqué');
      localSettlementIds.add(payment.syncOperationId);
    }
    if (!payment.syncOperationId || !settled.has(payment.syncOperationId)) balance -= BigInt(payment.amount);
  }
  return { balance: safe(balance), conflict };
}

export { calculateJournalClient, calculateJournalDay, validatePreInvoiceCreditChoice } from './journal.js';
export type { JournalClientInput, JournalPayment, TourInvoice } from './journal.js';
