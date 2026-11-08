/** Gardes passives : les routes d'avoir ne sont pas activées. Une base non
 * migrée reste utilisable tant qu'aucun registre n'existe ; une migration
 * partielle est refusée plutôt que de contourner un éventuel avoir. */
import type {PoolClient} from 'pg';
import {JournalConflict} from './journal-store.js';
import {IdentifiedOverlap} from './identified-overlap.js';
async function tablesPresent(db:PoolClient):Promise<boolean>{
 const r=await db.query(`SELECT to_regclass('credit_note_prototype_operation_ids') IS NOT NULL AS ids,
  to_regclass('credit_note_prototype_events') IS NOT NULL AS sales,
  to_regclass('pre_invoice_credit_prototype_events') IS NOT NULL AS journals`);
 const row=r.rows[0];
 if(!row||typeof row.ids!=='boolean'||typeof row.sales!=='boolean'||typeof row.journals!=='boolean')throw new Error('État des tables d’avoir indisponible.');
 if(!row.ids&&!row.sales&&!row.journals)return false;
 if(!row.ids||!row.sales||!row.journals)throw new Error('Migration des avoirs incomplète.');
 return true;
}
/** À appeler sous le verrou UUID global avant une écriture identifiée. */
export async function assertCreditOperationAvailable(db:PoolClient,operationId:string):Promise<void>{
 if(!await tablesPresent(db))return;
 if((await db.query('SELECT 1 FROM credit_note_prototype_operation_ids WHERE operation_id=$1',[operationId])).rows.length)throw new IdentifiedOverlap('Identifiant déjà utilisé par un avoir.');
}
/** La vente ou facture de journal doit être verrouillée avant cet appel.
 * Les doublons exacts déjà reçus sont traités avant cette vérification. */
export async function assertInvoiceNotCredited(db:PoolClient,kind:'sale'|'preinvoice',invoiceId:string):Promise<void>{
 if(!await tablesPresent(db))return;
 const table=kind==='sale'?'credit_note_prototype_events':'pre_invoice_credit_prototype_events';
 if((await db.query(`SELECT 1 FROM ${table} WHERE invoice_id=$1`,[invoiceId])).rows.length)throw new JournalConflict('Facture annulée : modification ou paiement refusé.');
}
