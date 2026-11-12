/** Tables expérimentales : exclusivement pour les espaces v5 non activés. */
export const remoteSaleDraftPrototypeSchema=`CREATE TABLE IF NOT EXISTS credit_remote_sale_draft_prototype (
 operation_id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL UNIQUE, commercial_id TEXT NOT NULL,
 server_origin TEXT NOT NULL, request TEXT NOT NULL, preview TEXT NOT NULL
);`;
export const remoteSaleConfirmPrototypeSchema=`CREATE TABLE IF NOT EXISTS credit_remote_sale_confirm_prototype (
 operation_id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, client_id TEXT NOT NULL,
 commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL, recorded_at TEXT NOT NULL,
 request TEXT NOT NULL, original TEXT NOT NULL, revised TEXT NOT NULL, payload TEXT NOT NULL,
 acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1,2))
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_remote_sale_pending_unique ON credit_remote_sale_confirm_prototype(invoice_id) WHERE acknowledged<2;
CREATE TABLE IF NOT EXISTS credit_local_sale_reconcile_prototype (
 operation_id TEXT PRIMARY KEY, revision_id INTEGER NOT NULL UNIQUE, sale_id TEXT NOT NULL,
 commercial_id TEXT NOT NULL, event TEXT NOT NULL, synced_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_remote_sale_receipt_prototype (
 operation_id TEXT PRIMARY KEY, receipt TEXT NOT NULL, reference_version INTEGER NOT NULL, confirmed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_remote_sale_abandoned_prototype (
 operation_id TEXT PRIMARY KEY, server_receipt TEXT NOT NULL, confirmed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_remote_sale_failure_prototype (
 operation_id TEXT PRIMARY KEY, reason TEXT NOT NULL CHECK(reason IN ('closed','conflict')),
 day TEXT, commercial_id TEXT
);`;
