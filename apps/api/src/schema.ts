// Migration relançable du prototype ; toutes les valeurs monétaires sont en millimes.
export const schemaSql = `CREATE SEQUENCE IF NOT EXISTS article_code_seq;
    CREATE TABLE IF NOT EXISTS clients (
      id uuid PRIMARY KEY, name text NOT NULL, sector text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '',
      tax_id text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', opening_balance bigint NOT NULL DEFAULT 0,
      credit_limit bigint NOT NULL DEFAULT 0 CHECK (credit_limit >= 0), active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
    );
    -- Le statut est versionné même si une modification provient d'un autre
    -- point d'entrée SQL : une réponse réseau ancienne ne doit pas réactiver
    -- silencieusement un client désactivé sur un téléphone.
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS status_revision bigint NOT NULL DEFAULT 1 CHECK (status_revision > 0);
    CREATE OR REPLACE FUNCTION sls_client_status_revision() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.active IS DISTINCT FROM OLD.active THEN
        NEW.status_revision := OLD.status_revision + 1;
      ELSE
        NEW.status_revision := OLD.status_revision;
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS sls_client_status_revision_trigger ON clients;
    CREATE TRIGGER sls_client_status_revision_trigger BEFORE UPDATE ON clients
      FOR EACH ROW EXECUTE FUNCTION sls_client_status_revision();
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
    -- Reprises idempotentes des demandes de clôture/réouverture.
    CREATE TABLE IF NOT EXISTS tour_closure_requests (
      request_id uuid PRIMARY KEY, commercial_id uuid NOT NULL REFERENCES commercials(id), journal_date date NOT NULL,
      action text NOT NULL CHECK(action IN ('close','reopen')), actor_id text NOT NULL,
      actor_role text NOT NULL CHECK(actor_role IN ('commercial','admin')),
      expected_version integer NOT NULL CHECK(expected_version>=0), result_version integer NOT NULL CHECK(result_version>0),
      occurred_at timestamptz NOT NULL
    );
    ALTER TABLE tour_closure_requests ADD COLUMN IF NOT EXISTS admin_refund_proof jsonb;
    CREATE TABLE IF NOT EXISTS tour_close_abandoned_requests (request_id uuid PRIMARY KEY, commercial_id uuid NOT NULL REFERENCES commercials(id), journal_date date NOT NULL, expected_version integer NOT NULL CHECK(expected_version>=0), abandoned_at timestamptz NOT NULL DEFAULT now());
    -- Préparation d'une bascule exclusive ; aucun endpoint ne permet encore de changer ce mode.
    CREATE TABLE IF NOT EXISTS tour_sync_mode (
      id integer PRIMARY KEY CHECK(id=1), mode text NOT NULL CHECK(mode IN ('legacy','identified'))
    );
    INSERT INTO tour_sync_mode(id,mode) VALUES(1,'legacy') ON CONFLICT(id) DO NOTHING;
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
    CREATE INDEX IF NOT EXISTS sync_journal_events_latest_idx ON sync_journal_events(invoice_id,version DESC);
    -- Espace isolé pour la future synchronisation authentifiée ; non compris dans les soldes.
    CREATE TABLE IF NOT EXISTS identified_journal_invoices (
      id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), journal_date date NOT NULL,
      commercial_id uuid NOT NULL REFERENCES commercials(id), created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(client_id,journal_date)
    );
    -- Une facture héritée n'a pas d'auteur commercial fiable.
    ALTER TABLE identified_journal_invoices ALTER COLUMN commercial_id DROP NOT NULL;
    CREATE TABLE IF NOT EXISTS identified_journal_receipt_ids (
      id uuid PRIMARY KEY, invoice_id uuid NOT NULL REFERENCES identified_journal_invoices(id)
    );
    CREATE TABLE IF NOT EXISTS identified_journal_events (
      operation_id uuid PRIMARY KEY, invoice_id uuid NOT NULL REFERENCES identified_journal_invoices(id),
      commercial_id uuid NOT NULL REFERENCES commercials(id), version integer NOT NULL CHECK(version>0),
      payload jsonb NOT NULL, payload_hash text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(invoice_id,version)
    );
    CREATE INDEX IF NOT EXISTS identified_journal_events_latest_idx ON identified_journal_events(invoice_id,version DESC);
    -- Espace isolé de validation, absent des soldes et des routes actives.
    CREATE TABLE IF NOT EXISTS identified_sale_events (
      operation_id uuid PRIMARY KEY, sale_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
      client_id uuid NOT NULL REFERENCES clients(id), commercial_id uuid NOT NULL REFERENCES commercials(id),
      journal_date date NOT NULL, payload jsonb NOT NULL, payload_hash text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(), UNIQUE(sale_id,version)
    );
    -- Réservations d'UUID pour les révisions distantes explicitement abandonnées.
    CREATE TABLE IF NOT EXISTS remote_sale_abandon_prototype (
      operation_id uuid PRIMARY KEY, sale_id uuid NOT NULL, version integer NOT NULL CHECK(version>1),
      commercial_id uuid NOT NULL REFERENCES commercials(id), payload jsonb NOT NULL, payload_hash text NOT NULL,
      abandoned_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE identified_sale_events ADD COLUMN IF NOT EXISTS event_date date;
    CREATE INDEX IF NOT EXISTS identified_sale_events_latest_idx ON identified_sale_events(sale_id,version DESC);
    CREATE TABLE IF NOT EXISTS identified_settlements (
      operation_id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id),
      commercial_id uuid NOT NULL REFERENCES commercials(id), journal_date date NOT NULL,
      payload jsonb NOT NULL, payload_hash text NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
    );
    -- Réservées aux tests : routes et soldes d'avoir non activés.
    CREATE TABLE IF NOT EXISTS credit_note_prototype_operation_ids (operation_id uuid PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS credit_refund_assignment_prototype (
      note_operation_id uuid PRIMARY KEY REFERENCES credit_note_prototype_operation_ids(operation_id),
      request_id uuid NOT NULL UNIQUE, commercial_id uuid REFERENCES commercials(id),
      refund bigint NOT NULL CHECK(refund>0), actor_id text NOT NULL CHECK(length(trim(actor_id)) BETWEEN 1 AND 200),
      assigned_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS credit_note_abandon_prototype (
      operation_id uuid PRIMARY KEY REFERENCES credit_note_prototype_operation_ids(operation_id),
      kind text NOT NULL CHECK(kind IN ('sale','preinvoice')), invoice_id uuid NOT NULL,
      commercial_id uuid NOT NULL REFERENCES commercials(id), command jsonb NOT NULL,
      abandoned_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS credit_note_prototype_events (
      operation_id uuid PRIMARY KEY, invoice_id uuid NOT NULL UNIQUE, event jsonb NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS credit_note_prototype_movements (
      operation_id uuid NOT NULL REFERENCES credit_note_prototype_events(operation_id),
      kind text NOT NULL CHECK(kind IN ('invoice_cancellation','refund')), balance_delta bigint NOT NULL,
      PRIMARY KEY(operation_id,kind)
    );
    CREATE TABLE IF NOT EXISTS pre_invoice_credit_prototype_events (
      operation_id uuid PRIMARY KEY, invoice_id uuid NOT NULL UNIQUE, event jsonb NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS pre_invoice_credit_prototype_movements (
      operation_id uuid NOT NULL REFERENCES pre_invoice_credit_prototype_events(operation_id),
      kind text NOT NULL CHECK(kind IN ('invoice_cancellation','refund')), balance_delta bigint NOT NULL,
      PRIMARY KEY(operation_id,kind)
    );`;
