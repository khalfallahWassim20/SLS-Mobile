import { pool } from './db.js';
import { schemaSql } from './schema.js';
// Cette première migration est relançable et ne supprime pas les données.
try {
  await pool.query(schemaSql);
  console.log('Migration terminée.');
} finally { await pool.end(); }
