import { pool } from './db.js';
// Cette première migration est relançable et ne supprime pas les données.
try {
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS article_code_seq;
    CREATE TABLE IF NOT EXISTS clients (
      id uuid PRIMARY KEY, name text NOT NULL, sector text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '',
      tax_id text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', opening_balance bigint NOT NULL DEFAULT 0,
      credit_limit bigint NOT NULL DEFAULT 0 CHECK (credit_limit >= 0), active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS articles (
      id uuid PRIMARY KEY, code text UNIQUE NOT NULL, barcode text NOT NULL DEFAULT '', name text NOT NULL,
      purchase_ttc bigint NOT NULL CHECK (purchase_ttc >= 0), sale_ttc bigint NOT NULL CHECK (sale_ttc >= 0),
      vat_rate integer NOT NULL DEFAULT 1900 CHECK (vat_rate BETWEEN 0 AND 10000),
      units_per_carton integer NOT NULL DEFAULT 1 CHECK (units_per_carton > 0), active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
    );`);
  console.log('Migration terminée.');
} finally { await pool.end(); }
