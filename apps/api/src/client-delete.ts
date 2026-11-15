/** Suppression définitive d'un client : réservée aux clients sans aucune opération enregistrée. */
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

// Tables qui conservent des opérations liées à un client (colonne client_id).
const LINKED: [string, string][] = [
  ['demo_sale_events', 'vente(s)'], ['demo_settlements', 'règlement(s)'],
  ['demo_journal_invoices', 'facture(s) de journal démo'], ['sync_journal_invoices', 'facture(s) de journal'],
  ['identified_journal_invoices', 'facture(s) de journal identifié'], ['identified_sale_events', 'vente(s) identifiée(s)'],
  ['identified_settlements', 'règlement(s) identifié(s)']
];

/** Supprimer ce client fausserait des soldes ou des journaux : il faut le désactiver. */
export class ClientHasOperations extends Error {
  constructor(readonly usage: { label: string; count: number }[]) {
    super(`Suppression impossible : ce client a des opérations enregistrées (${usage.map(u => `${u.count} ${u.label}`).join(', ')}). Désactivez-le à la place.`);
  }
}

/** Retourne false si le client n'existe pas. Le contrôle, la suppression et le journal d'audit sont atomiques. */
export async function deleteClientPermanently(pool: Pool, actor: string, id: string): Promise<boolean> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Le verrou bloque, pendant le contrôle, les envois mobiles concurrents pour ce client.
    const client = (await db.query('SELECT name FROM clients WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
    if (!client) { await db.query('ROLLBACK'); return false; }
    const counts = await db.query(LINKED.map(([table, label]) => `SELECT '${label}' AS label, count(*)::int AS count FROM ${table} WHERE client_id=$1`).join(' UNION ALL '), [id]);
    const usage = counts.rows.filter(row => row.count > 0).map(row => ({ label: row.label as string, count: row.count as number }));
    if (usage.length) throw new ClientHasOperations(usage);
    await db.query('DELETE FROM clients WHERE id=$1', [id]);
    await db.query(`INSERT INTO audit_log(id,actor,action,entity,entity_id,entity_name,changed_fields) VALUES($1,$2,'suppression','clients',$3,$4,'{}')`, [randomUUID(), actor, id, client.name]);
    await db.query('COMMIT');
    return true;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
