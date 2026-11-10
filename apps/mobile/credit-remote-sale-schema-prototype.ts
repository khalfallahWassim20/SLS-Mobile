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
CREATE UNIQUE INDEX IF NOT EXISTS credit_remote_sale_pending_unique ON credit_remote_sale_confirm_prototype(invoice_id) WHERE acknowledged<2;`;
