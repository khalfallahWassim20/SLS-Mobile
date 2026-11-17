/** Registres préparatoires de facture du jour. Leur présence n'active aucune
 * route : les anciennes écritures et lectures restent protégées par leurs gardes. */
export const dayInvoiceServerSchema=`CREATE TABLE IF NOT EXISTS identified_day_invoice_payments (
 operation_id UUID PRIMARY KEY, client_id UUID NOT NULL REFERENCES clients(id), commercial_id UUID NOT NULL REFERENCES commercials(id),
 invoice_day DATE NOT NULL, event_day DATE NOT NULL, payload JSONB NOT NULL, payload_hash TEXT NOT NULL
); CREATE INDEX IF NOT EXISTS day_invoice_payment_client_day ON identified_day_invoice_payments(client_id,invoice_day);
 CREATE TABLE IF NOT EXISTS identified_day_invoice_old_debt (
 operation_id UUID PRIMARY KEY REFERENCES identified_settlements(operation_id), invoice_day DATE NOT NULL
 );
 CREATE TABLE IF NOT EXISTS identified_day_invoice_compensations (
 operation_id UUID PRIMARY KEY REFERENCES identified_sale_events(operation_id),
 client_id UUID NOT NULL REFERENCES clients(id), commercial_id UUID NOT NULL REFERENCES commercials(id),
 invoice_day DATE NOT NULL, event_day DATE NOT NULL, payload JSONB NOT NULL, payload_hash TEXT NOT NULL
 );
 ALTER TABLE identified_day_invoice_compensations ADD COLUMN IF NOT EXISTS receipt_required BOOLEAN NOT NULL DEFAULT FALSE;
 CREATE TABLE IF NOT EXISTS identified_day_invoice_compensation_receipts (
 operation_id UUID PRIMARY KEY REFERENCES identified_day_invoice_compensations(operation_id) ON DELETE CASCADE,
 commercial_id UUID NOT NULL REFERENCES commercials(id), projection JSONB NOT NULL, projection_hash TEXT NOT NULL
 );`;
