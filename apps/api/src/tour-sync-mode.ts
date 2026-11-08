import type {Pool,PoolClient} from 'pg';
export class LegacySyncDisabled extends Error {
 constructor() {super('Synchronisation partagée désactivée : connexion individuelle requise.');}
}
type Mode='legacy'|'identified';
function parseMode(mode:unknown):Mode {
 if(mode!=='legacy'&&mode!=='identified')throw new Error('État de transition de synchronisation indisponible.');return mode;
}
/** Lecture avec verrou partagé dans la transaction d'écriture. Une future bascule doit
 * acquérir FOR UPDATE sur la même ligne, puis ne jamais revenir à l'ancien mode. */
export async function lockSyncMode(db:PoolClient):Promise<Mode> {
 const r=await db.query('SELECT mode FROM tour_sync_mode WHERE id=1 FOR SHARE');return parseMode(r.rows[0]?.mode);
}
export async function readSyncMode(pool:Pool):Promise<Mode> {
 const r=await pool.query('SELECT mode FROM tour_sync_mode WHERE id=1');return parseMode(r.rows[0]?.mode);
}
/** À appeler seulement après l'éventuelle reconnaissance d'un doublon déjà reçu. */
export function assertLegacyMode(mode:Mode):void {if(mode!=='legacy')throw new LegacySyncDisabled();}

export class IdentifiedSyncDisabled extends Error {
 constructor() {super('Synchronisation individuelle non activée.');}
}
export function assertIdentifiedMode(mode:Mode):void {if(mode!=='identified')throw new IdentifiedSyncDisabled();}
