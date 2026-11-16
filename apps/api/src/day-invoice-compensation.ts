/** Registre préparatoire de la première compensation d'une facture du jour.
 * Ne pas exposer avant l'intégration des soldes, de la caisse et du mobile. */
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {JournalConflict} from './journal-store.js';
const money=z.number().int().safe().nonnegative();
export const compensationSchema=z.object({choice:z.enum(['refund','credit']),amount:money.positive(),previousTotal:money,paid:money}).strict();
export type DayCompensation=z.infer<typeof compensationSchema>;
export function compensationHash(value:DayCompensation){return createHash('sha256').update(JSON.stringify(compensationSchema.parse(value))).digest('hex');}
export async function compensationRegistryExists(db:PoolClient){
 const result=await db.query("SELECT to_regclass('identified_day_invoice_compensations') IS NOT NULL AS present");
 if(typeof result.rows[0]?.present!=='boolean')throw Error('Registre de compensation indisponible.');return result.rows[0].present as boolean;
}
/** Les lecteurs existants ne savent pas encore comptabiliser les compensations.
 * Interdire leur utilisation plutôt que présenter un solde ou une caisse faux. */
export async function assertNoUnprojectedCompensation(db:PoolClient){
 if(!await compensationRegistryExists(db))return;
 const result=await db.query('SELECT EXISTS(SELECT 1 FROM identified_day_invoice_compensations) AS present');
 if(result.rows[0]?.present!==false)throw new JournalConflict('Compensation de facture du jour non projetée : rapprochement requis.');
}
