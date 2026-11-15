/** N'autorise pas un raccourci quand le journal du client peut nécessiter un traitement préétabli. */
export function canQuickSettleJournal(input: {
  clientId: string;
  referenceVersion: number | undefined;
  journalStates: readonly {clientId:string}[] | undefined;
  preInvoices: readonly {clientId:string}[];
  receipts: readonly {clientId:string}[];
}): boolean {
  return input.referenceVersion === 3 && !!input.journalStates &&
    !input.journalStates.some(p => p.clientId === input.clientId) &&
    !input.preInvoices.some(p => p.clientId === input.clientId) &&
    !input.receipts.some(p => p.clientId === input.clientId);
}
