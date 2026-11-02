/** Calculs de démonstration du journal de tournée. Tous les montants sont en millimes. */
export type JournalPayment = { amount: number; mode: 'espèces' | 'chèque' | 'virement' };
export type TourInvoice = { total: number; paid: number; cancelled?: boolean };
export type JournalClientInput = {
  clientId: string;
  preInvoiceTotal: number | null;
  preInvoicePayments: JournalPayment[];
  oldDebtPayments: JournalPayment[];
  /** Dette connue avant ajout de la facture préétablie et de ces règlements. */
  oldBalance: number;
  tourInvoices: TourInvoice[];
};
function integer(value: number, name: string, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`${name} invalide`);
}
function safe(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError('Montant trop élevé');
  return Number(value);
}
function sumPayments(payments: JournalPayment[]): bigint {
  return payments.reduce((sum, p) => {
    integer(p.amount, 'Paiement', 1);
    if (!['espèces', 'chèque', 'virement'].includes(p.mode)) throw new RangeError('Mode de paiement invalide');
    return sum + BigInt(p.amount);
  }, 0n);
}
/** Totaux d'un client. Les paiements de facture de tournée sont déjà dans tourInvoices,
 * et ne doivent pas aussi être fournis dans preInvoicePayments ou oldDebtPayments.
 * Solde signé : positif = dette ; négatif = crédit en faveur du client.
 */
export function calculateJournalClient(input: JournalClientInput) {
  if (!input.clientId.trim()) throw new RangeError('Client requis');
  integer(input.oldBalance, 'Ancien solde', Number.MIN_SAFE_INTEGER);
  if (input.preInvoiceTotal !== null) integer(input.preInvoiceTotal, 'Facture préétablie', 1);
  const preTotal = BigInt(input.preInvoiceTotal ?? 0);
  const prePaid = sumPayments(input.preInvoicePayments), oldDebtPaid = sumPayments(input.oldDebtPayments);
  if (prePaid > preTotal) throw new RangeError('Paiement supérieur à la facture préétablie');
  if (oldDebtPaid > BigInt(Math.max(0, input.oldBalance))) throw new RangeError('Règlement supérieur à l’ancienne dette connue');
  let tourTotal = 0n, tourPaid = 0n;
  for (const invoice of input.tourInvoices) {
    integer(invoice.total, 'Facture de tournée'); integer(invoice.paid, 'Paiement de tournée');
    // Une facture annulée ne contribue ni au facturé ni à l'encaissé du journal.
    if (!invoice.cancelled) {
      if (invoice.paid > invoice.total) throw new RangeError('Paiement de tournée supérieur au total : traitement du crédit à définir');
      tourTotal += BigInt(invoice.total); tourPaid += BigInt(invoice.paid);
    }
  }
  const preRemaining = preTotal - prePaid;
  return {
    clientId: input.clientId,
    preInvoiceTotal: safe(preTotal), preInvoicePaid: safe(prePaid), oldDebtPaid: safe(oldDebtPaid),
    tourTotal: safe(tourTotal), tourPaid: safe(tourPaid),
    totalBilled: safe(preTotal + tourTotal), totalCollected: safe(prePaid + oldDebtPaid + tourPaid),
    // Ne comprend pas l'ancienne dette : uniquement les factures de la journée.
    remainingToday: safe(preRemaining + tourTotal - tourPaid),
    // L'effet des factures de tournée est géré par leur propre registre : ne pas l'ajouter deux fois.
    preInvoiceBalanceDelta: safe(preRemaining - oldDebtPaid),
    balanceAfterPreInvoiceAndOldDebt: safe(BigInt(input.oldBalance) + preRemaining - oldDebtPaid),
  };
}
/** À utiliser lors de la validation du traitement d'une facture préétablie,
 * et non lors de la saisie initiale dans le journal. */
export function validatePreInvoiceCreditChoice(preInvoiceTotal: number, totalPaid: number, creditChecked: boolean): void {
  integer(preInvoiceTotal, 'Facture préétablie', 1); integer(totalPaid, 'Paiement');
  if (totalPaid > preInvoiceTotal) throw new RangeError('Paiement supérieur à la facture');
  if (creditChecked && totalPaid > 0) throw new RangeError('La case crédit total est réservée aux factures entièrement impayées');
  if (!creditChecked && totalPaid === 0) throw new RangeError('Cochez crédit pour une facture entièrement impayée');
}
export function calculateJournalDay(clients: JournalClientInput[]) {
  const ids = new Set<string>();
  let billed = 0n, collected = 0n, oldDebtPaid = 0n;
  const rows = clients.map(client => {
    if (ids.has(client.clientId)) throw new RangeError('Un client ne peut apparaître qu’une fois dans le journal');
    ids.add(client.clientId);
    const row = calculateJournalClient(client);
    billed += BigInt(row.totalBilled); collected += BigInt(row.totalCollected); oldDebtPaid += BigInt(row.oldDebtPaid);
    return row;
  });
  return { rows, clientCount: rows.length, totalBilled: safe(billed), totalCollected: safe(collected), oldDebtPaid: safe(oldDebtPaid) };
}
