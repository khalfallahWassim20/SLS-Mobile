/** L'appelant doit avoir confirmé la suppression ; à exécuter en transaction exclusive.
 * L'identité du téléphone est conservée, mais les caches deviennent invalides. */
type Tx={runAsync(sql:string,...params:(string|number|null)[]):Promise<unknown>};
export async function resetLocalTestOperations(tx:Tx):Promise<void> {
 for(const table of ['credit_remote_sale_confirm_prototype','credit_remote_sale_draft_prototype','credit_protocol_quarantine','credit_sources_prototype_cache','credit_reference_prototype_cache','offline_credit_prototype','sales_outbox','sale_event_times','sale_revisions','sales','settlements',
  'journal_sync_outbox','journal_sync_state','tour_journal_receipts','tour_pre_invoices',
  'identified_local_operations','identified_reference_cache','tour_close_attempts','tour_known_server_states','reference_snapshot']) {
  await tx.runAsync(`DELETE FROM ${table}`);
 }
}
