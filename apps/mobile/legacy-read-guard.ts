/** Lecture des anciens écrans, à exécuter dans une transaction SQLite.
 * Les écrans v5 doivent utiliser leurs captures dédiées, jamais cette lecture. */
import {getDeviceIdentity} from './identified-device';
import {assertLegacyMobileCreditSafe} from './credit-note-write-guard-prototype';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
export async function readLegacyRows<T>(tx:Tx,sql:string,...params:Bind[]):Promise<T[]> {
 await assertLegacyMobileCreditSafe(tx,await getDeviceIdentity(tx));
 return tx.getAllAsync<T>(sql,...params);
}
