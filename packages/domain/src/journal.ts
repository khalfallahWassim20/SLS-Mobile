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

/** Événement local du journal : les deux montants restent des paiements distincts. */
export type PreInvoiceReceipt = { prePaid: number; oldDebtPaid: number; creditFull: boolean };
export function summarizePreInvoice(total: number, receipts: PreInvoiceReceipt[]) {
  integer(total, 'Facture préétablie', 1);
  let prePaid=0n, oldDebtPaid=0n, declared=false;
  for (const receipt of receipts) {
    integer(receipt.prePaid, 'Paiement de facture'); integer(receipt.oldDebtPaid, 'Règlement de dette');
    if (typeof receipt.creditFull !== 'boolean') throw new RangeError('Choix crédit invalide');
    if (receipt.creditFull && (receipt.prePaid > 0 || prePaid > 0n || declared)) throw new RangeError('Le crédit total concerne seulement une facture entièrement impayée et non encore déclarée');
    if (receipt.creditFull || receipt.prePaid > 0) declared=true;
    prePaid += BigInt(receipt.prePaid); oldDebtPaid += BigInt(receipt.oldDebtPaid);
    if (prePaid > BigInt(total)) throw new RangeError('Paiement supérieur à la facture préétablie');
  }
  const remaining=BigInt(total)-prePaid;
  // Le montant de la facture est ajouté au solde seulement après paiement ou choix crédit.
  const debtEffect=(declared ? remaining : 0n) - oldDebtPaid;
  return { prePaid:safe(prePaid), oldDebtPaid:safe(oldDebtPaid), remaining:safe(remaining), declared, debtEffect:safe(debtEffect), totalCollected:safe(prePaid+oldDebtPaid) };
}
export function validatePreInvoiceReceipt(total: number, previous: PreInvoiceReceipt[], next: PreInvoiceReceipt, availableOldDebt: number) {
  integer(availableOldDebt, 'Ancienne dette disponible');
  const before=summarizePreInvoice(total,previous);
  if (!next.creditFull && next.prePaid === 0 && next.oldDebtPaid === 0) throw new RangeError('Saisissez un paiement ou choisissez crédit total');
  if (!before.declared && next.prePaid === 0 && !next.creditFull) throw new RangeError('Pour une facture entièrement impayée, choisissez crédit total');
  if (next.oldDebtPaid > availableOldDebt) throw new RangeError('Règlement supérieur à l’ancienne dette disponible');
  return summarizePreInvoice(total,[...previous,next]);
}

/** Instantané immuable d'une facture du journal pour le rapprochement.
 * Le tableau des opérations est ordonné et doit être un préfixe de la version locale.
 * Les données serveur doivent provenir du même instantané que le solde serveur. */
export type JournalSyncReceipt = PreInvoiceReceipt & { id: string };
export type JournalSyncInvoice = { id: string; total: number; receipts: JournalSyncReceipt[] };
export function reconcileJournalBalance(serverBalance: number, local: JournalSyncInvoice[], server: JournalSyncInvoice[]) {
  integer(serverBalance, 'Solde serveur', Number.MIN_SAFE_INTEGER);
  const check = (invoices: JournalSyncInvoice[]) => {
    const ids = new Set<string>(), receiptIds = new Set<string>();
    for (const invoice of invoices) {
      if (typeof invoice.id !== 'string' || !invoice.id.trim() || ids.has(invoice.id)) throw new RangeError('Facture du journal invalide ou dupliquée');
      ids.add(invoice.id);
      for (const receipt of invoice.receipts) {
        if (typeof receipt.id !== 'string' || !receipt.id.trim() || receiptIds.has(receipt.id)) throw new RangeError('Opération du journal invalide ou dupliquée');
        receiptIds.add(receipt.id);
      }
      summarizePreInvoice(invoice.total, invoice.receipts);
    }
  };
  check(local); check(server);
  const remote = new Map(server.map(invoice => [invoice.id, invoice]));
  const remoteReceiptOwners = new Map(server.flatMap(invoice => invoice.receipts.map(receipt => [receipt.id, invoice.id] as const)));
  let balance = BigInt(serverBalance), conflict = local.some(invoice => invoice.receipts.some(receipt => {
    const owner = remoteReceiptOwners.get(receipt.id); return owner !== undefined && owner !== invoice.id;
  }));
  for (const invoice of local) {
    const localSummary = summarizePreInvoice(invoice.total, invoice.receipts);
    const received = remote.get(invoice.id);
    if (!received) { balance += BigInt(localSummary.debtEffect); continue; }
    if (received.total !== invoice.total || received.receipts.length > invoice.receipts.length || received.receipts.some((receipt, i) => {
      const other = invoice.receipts[i];
      return !other || receipt.id !== other.id || receipt.prePaid !== other.prePaid || receipt.oldDebtPaid !== other.oldDebtPaid || receipt.creditFull !== other.creditFull;
    })) { conflict = true; continue; }
    const receivedSummary = summarizePreInvoice(received.total, received.receipts);
    balance += BigInt(localSummary.debtEffect) - BigInt(receivedSummary.debtEffect);
  }
  return { balance: safe(balance), conflict };
}
