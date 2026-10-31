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
  return !adminOverride && balance >= creditLimit;
}
