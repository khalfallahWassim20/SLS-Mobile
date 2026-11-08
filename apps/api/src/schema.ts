// Migration relançable du prototype ; toutes les valeurs monétaires sont en millimes.
export const schemaSql = `CREATE SEQUENCE IF NOT EXISTS article_code_seq;
    CREATE TABLE IF NOT EXISTS clients (
      id uuid PRIMARY KEY, name text NOT NULL, sector text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '',
      tax_id text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', opening_balance bigint NOT NULL DEFAULT 0,
      credit_limit bigint NOT NULL DEFAULT 0 CHECK (credit_limit >= 0), active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS commercials (
      id uuid PRIMARY KEY, name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
      active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
    );
    -- Comptes préparatoires : aucun accès mobile accordé à ce stade.
    CREATE TABLE IF NOT EXISTS commercial_credentials (
      commercial_id uuid PRIMARY KEY REFERENCES commercials(id), login text NOT NULL UNIQUE,
      password_hash text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE commercial_credentials ADD COLUMN IF NOT EXISTS session_version bigint NOT NULL DEFAULT 1;
    -- Préparation des clôtures : non exposée et sans verrouillage des écritures existantes.
    CREATE TABLE IF NOT EXISTS tour_closures (
      commercial_id uuid NOT NULL REFERENCES commercials(id), journal_date date NOT NULL,
      status text NOT NULL CHECK(status IN ('open','closed')), version integer NOT NULL CHECK(version >= 0),
      closed_at timestamptz, PRIMARY KEY(commercial_id,journal_date),
      CHECK ((status='open' AND closed_at IS NULL) OR (status='closed' AND closed_at IS NOT NULL AND version>0))
    );
    CREATE TABLE IF NOT EXISTS tour_closure_events (
      id uuid PRIMARY KEY, commercial_id uuid NOT NULL, journal_date date NOT NULL,
      action text NOT NULL CHECK(action IN ('close','reopen')), actor_id text NOT NULL,
      actor_role text NOT NULL CHECK(actor_role IN ('commercial','admin')),
      occurred_at timestamptz NOT NULL, version integer NOT NULL CHECK(version>0),
      UNIQUE(commercial_id,journal_date,version),
      FOREIGN KEY(commercial_id,journal_date) REFERENCES tour_closures(commercial_id,journal_date)
    );
    CREATE TABLE IF NOT EXISTS articles (
      id uuid PRIMARY KEY, code text UNIQUE NOT NULL, barcode text NOT NULL DEFAULT '', name text NOT NULL,
      purchase_ttc bigint NOT NULL CHECK (purchase_ttc >= 0), sale_ttc bigint NOT NULL CHECK (sale_ttc >= 0),
      vat_rate integer NOT NULL DEFAULT 1900 CHECK (vat_rate BETWEEN 0 AND 10000),
      units_per_carton integer NOT NULL DEFAULT 1 CHECK (units_per_carton > 0), active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id uuid PRIMARY KEY, actor text NOT NULL, action text NOT NULL, entity text NOT NULL,
      entity_id uuid NOT NULL, entity_name text NOT NULL, changed_fields text[] NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);
    CREATE TABLE IF NOT EXISTS demo_sale_events (
      operation_id uuid PRIMARY KEY, sale_id uuid NOT NULL, version integer NOT NULL CHECK (version > 0),
      client_id uuid NOT NULL, payload jsonb NOT NULL, payload_hash text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(sale_id,version)
    );
    CREATE INDEX IF NOT EXISTS demo_sale_events_latest_idx ON demo_sale_events(sale_id,version DESC);
    CREATE TABLE IF NOT EXISTS demo_settlements (
      operation_id uuid PRIMARY KEY, client_id uuid NOT NULL, payload jsonb NOT NULL, payload_hash text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS demo_settlements_client_idx ON demo_settlements(client_id);
    -- Préparation uniquement : ces tables ne sont pas encore utilisées par les soldes ni par une API publique.
    CREATE TABLE IF NOT EXISTS demo_journal_invoices (
      id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), journal_date date NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(client_id,journal_date)
    );
    CREATE TABLE IF NOT EXISTS demo_journal_receipt_ids (
      id uuid PRIMARY KEY, invoice_id uuid NOT NULL REFERENCES demo_journal_invoices(id)
    );
    CREATE TABLE IF NOT EXISTS demo_journal_events (
      operation_id uuid PRIMARY KEY, invoice_id uuid NOT NULL REFERENCES demo_journal_invoices(id),
      version integer NOT NULL CHECK (version > 0), payload jsonb NOT NULL, payload_hash text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(invoice_id,version)
    );
    CREATE INDEX IF NOT EXISTS demo_journal_events_latest_idx ON demo_journal_events(invoice_id,version DESC);
    -- Espace séparé des données expérimentales ; pas encore exposé aux téléphones.
    CREATE TABLE IF NOT EXISTS sync_journal_invoices (
      id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), journal_date date NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(client_id,journal_date)
    );
    CREATE TABLE IF NOT EXISTS sync_journal_receipt_ids (
      id uuid PRIMARY KEY, invoice_id uuid NOT NULL REFERENCES sync_journal_invoices(id)
    );
    CREATE TABLE IF NOT EXISTS sync_journal_events (
      operation_id uuid PRIMARY KEY, invoice_id uuid NOT NULL REFERENCES sync_journal_invoices(id),
      version integer NOT NULL CHECK (version > 0), payload jsonb NOT NULL, payload_hash text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(invoice_id,version)
    );
    CREATE INDEX IF NOT EXISTS sync_journal_events_latest_idx ON sync_journal_events(invoice_id,version DESC);`;
