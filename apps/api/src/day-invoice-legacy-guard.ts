/** Barrières de transition : les anciens traitements ne savent pas encore
 * calculer un paiement unifié. La table n'existe pas sur le serveur normal. */
import type {PoolClient} from 'pg';
import {JournalConflict} from './journal-store.js';
async function hasDayInvoiceTable(db:PoolClient):Promise<boolean> {
 const result=await db.query("SELECT to_regclass('identified_day_invoice_payments') IS NOT NULL AS present");
 if(typeof result.rows[0]?.present!=='boolean')throw Error('État du registre facture du jour indisponible.');
 return result.rows[0].present;
}
/** Verrou partagé entre anciennes écritures et paiements v6, toutes dates du
 * même client. À prendre après le verrou client/jour et garder jusqu'au commit. */
export async function lockDayInvoiceClient(db:PoolClient,clientId:string):Promise<void>{
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['journal-client-global',clientId]);
}
/** L'appelant conserve impérativement les verrous client/jour et client global jusqu'au commit. */
export async function assertLegacyClientDaySafe(db:PoolClient,clientId:string,day:string):Promise<void> {
 if(!await hasDayInvoiceTable(db))return;
 const result=await db.query('SELECT EXISTS(SELECT 1 FROM identified_day_invoice_payments WHERE client_id=$1) AS present',[clientId]);
 if(result.rows[0]?.present!==false)throw new JournalConflict('Règlement unifié déjà enregistré pour ce client : ancien traitement refusé.');
 const marker=await db.query("SELECT to_regclass('identified_day_invoice_old_debt') IS NOT NULL AS present");
 if(marker.rows[0]?.present===true){const debt=await db.query('SELECT EXISTS(SELECT 1 FROM identified_day_invoice_old_debt m JOIN identified_settlements s ON s.operation_id=m.operation_id WHERE s.client_id=$1) AS present',[clientId]);if(debt.rows[0]?.present!==false)throw new JournalConflict('Ancienne dette explicitement réglée : ancien traitement refusé.');}

}
/** Protocoles v6 uniquement : identifie une vente déjà réglée. L'appelant
 * doit recalculer la facture entière sous les verrous et refuser tout
 * trop-perçu ou remboursement sans protocole explicite. */
export async function assertDayInvoiceAwareSaleSafe(db:PoolClient,clientId:string,day:string,version:number):Promise<boolean>{
 await assertDayInvoiceCloseRegistry(db);
 const debt=await db.query('SELECT EXISTS(SELECT 1 FROM identified_day_invoice_old_debt m JOIN identified_settlements s ON s.operation_id=m.operation_id WHERE s.client_id=$1 AND ($2::int>1 OR m.invoice_day>$3::date)) AS present',[clientId,version,day]);
 if(debt.rows[0]?.present!==false)throw new JournalConflict('Modification antérieure à un règlement de dette : rapprochement requis.');
 if(version===1)return false;
 const result=await db.query('SELECT EXISTS(SELECT 1 FROM identified_day_invoice_payments WHERE client_id=$1 AND invoice_day=$2::date) AS present',[clientId,day]);
 if(typeof result.rows[0]?.present!=='boolean')throw new JournalConflict('État des règlements indisponible.');
 return result.rows[0].present;
}
/** Une création vide ne modifie aucune déclaration ; les anciens reçus restent
 * refusés lorsque le client possède déjà un règlement unifié. */
export async function assertDayInvoiceAwareJournalSafe(db:PoolClient,clientId:string,day:string,version:number,receiptCount:number):Promise<void>{
 await assertDayInvoiceCloseRegistry(db);
 const debt=await db.query('SELECT EXISTS(SELECT 1 FROM identified_day_invoice_old_debt m JOIN identified_settlements s ON s.operation_id=m.operation_id WHERE s.client_id=$1 AND ($2::int>1 OR $3::int>0 OR m.invoice_day>$4::date)) AS present',[clientId,version,receiptCount,day]);
 if(debt.rows[0]?.present!==false)throw new JournalConflict('Modification antérieure à un règlement de dette : rapprochement requis.');
 if(version===1&&receiptCount===0)return;
 await assertLegacyClientDaySafe(db,clientId,day);
}
/** Après verrou de clôture : ne pas valider une caisse qui ignore les paiements. */
export async function assertLegacyDayCloseSafe(db:PoolClient,commercialId:string,day:string):Promise<void> {
 if(!await hasDayInvoiceTable(db))return;
 const result=await db.query(`SELECT EXISTS(SELECT 1 FROM identified_day_invoice_payments WHERE commercial_id=$1 AND (invoice_day=$2::date OR event_day=$2::date))
 OR EXISTS(SELECT 1 FROM identified_day_invoice_payments p JOIN identified_journal_invoices i ON i.id::text=p.payload->'preInvoice'->>'id'
  WHERE i.commercial_id=$1 AND i.journal_date=$2::date AND p.payload->'preInvoice'->>'declare'='true') AS present`,[commercialId,day]);
 if(result.rows[0]?.present!==false)throw new JournalConflict('Règlements unifiés absents du calcul de clôture : rapprochement nécessaire.');
}
/** L'appelant doit déjà posséder le verrou d'opération global. */
export async function assertNoDayInvoiceOperation(db:PoolClient,id:string):Promise<void> {
 if(!await hasDayInvoiceTable(db))return;
 const result=await db.query('SELECT EXISTS(SELECT 1 FROM identified_day_invoice_payments WHERE operation_id=$1) AS present',[id]);
 if(result.rows[0]?.present!==false)throw new JournalConflict('Identifiant déjà utilisé pour un règlement unifié.');
}
/** Une clôture expérimentale ne doit pas interpréter une migration absente
 * comme un registre de paiements vide. */
export async function assertDayInvoiceCloseRegistry(db:PoolClient):Promise<void>{
 if(!await hasDayInvoiceTable(db))throw new JournalConflict('Registre de facture du jour indisponible.');
 const marker=await db.query("SELECT to_regclass('identified_day_invoice_old_debt') IS NOT NULL AS present");
 if(marker.rows[0]?.present!==true)throw new JournalConflict('Registre d’ancienne dette indisponible.');
}
/** Les anciennes références de solde ne tiennent pas compte de ces paiements.
 * À appeler dans le même instantané que la lecture, sous verrou de mode si la
 * référence peut servir ensuite à une écriture. */
export async function assertLegacyDayInvoiceReferenceSafe(db:PoolClient):Promise<void>{
 if(!await hasDayInvoiceTable(db))return;
 const result=await db.query('SELECT EXISTS(SELECT 1 FROM identified_day_invoice_payments) AS present');
 if(result.rows[0]?.present!==false)throw new JournalConflict('Règlements de facture du jour présents : ancienne référence de solde indisponible, mise à jour nécessaire.');
}
