/** L'appelant doit avoir confirmé la suppression ; à exécuter en transaction exclusive.
 * L'identité du téléphone est conservée, mais les caches deviennent invalides. */
type Tx={getFirstAsync<T>(sql:string,...params:(string|number|null)[]):Promise<T|null>;runAsync(sql:string,...params:(string|number|null)[]):Promise<unknown>};
export async function resetLocalTestOperations(tx:Tx):Promise<void> {
 // Compatibilité avec les bases d'avant migration : le groupe v6 doit être
 // intégralement présent ou absent, jamais partiellement nettoyé.
 const names=['day_invoice_payment_outbox','day_invoice_payments','day_invoice_reference_cache','day_invoice_close_attempt_markers'];
 const state=await tx.getFirstAsync<{n:number}>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('day_invoice_payment_outbox','day_invoice_payments','day_invoice_reference_cache','day_invoice_close_attempt_markers')");
 if(!state||![0,names.length].includes(state.n))throw Error('Migration facture du jour incomplète : nettoyage refusé.');
 if(state.n===names.length)for(const name of names)await tx.runAsync(`DELETE FROM ${name}`);
 const attempt=await tx.getFirstAsync<{n:number}>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='day_invoice_sale_attempt'");
 if(!attempt||![0,1].includes(attempt.n))throw Error('Migration tentative de vente incohérente.');
 if(attempt.n===1)await tx.runAsync('DELETE FROM day_invoice_sale_attempt');
 const debt=await tx.getFirstAsync<{n:number}>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('day_invoice_old_debt_local','day_invoice_old_debt_outbox')");
 if(!debt||![0,2].includes(debt.n))throw Error('Migration ancienne dette incomplète : nettoyage refusé.');
 if(debt.n===2){await tx.runAsync('DELETE FROM day_invoice_old_debt_outbox');await tx.runAsync('DELETE FROM day_invoice_old_debt_local');}
 for(const table of ['tour_expense_cancellations','tour_expense_revisions','tour_expenses','credit_abandoned_note_prototype','credit_local_sale_reconcile_prototype','credit_remote_sale_receipt_prototype','credit_remote_sale_abandoned_prototype','credit_remote_sale_failure_prototype','credit_remote_sale_confirm_prototype','credit_remote_sale_draft_prototype','credit_protocol_quarantine','credit_sources_prototype_cache','credit_reference_prototype_cache','offline_credit_prototype','sales_outbox','sale_event_times','sale_revisions','sales','settlements',
  'journal_sync_outbox','journal_sync_state','tour_journal_receipts','tour_pre_invoices',
  'identified_local_operations','identified_reference_cache','tour_close_cash_proofs','tour_close_admin_refund_proofs','tour_close_attempts','tour_known_server_states','reference_snapshot']) {
  await tx.runAsync(`DELETE FROM ${table}`);
 }
}
