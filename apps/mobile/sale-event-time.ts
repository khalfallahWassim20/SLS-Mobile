/** Horodatage local préparatoire : ne modifie pas le protocole actuel ni n'attribue une identité. */
export const saleEventTimeSchema=`CREATE TABLE IF NOT EXISTS sale_event_times (
 operation_id TEXT PRIMARY KEY, recorded_at TEXT NOT NULL
);`;
type Tx={runAsync(sql:string,...params:(string|number|null)[]):Promise<unknown>};
export async function recordSaleEventTime(tx:Tx,operationId:string,recordedAt:string):Promise<void> {
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) throw Error('Identifiant de vente invalide.');
 const parsed=new Date(recordedAt);
 if(!Number.isFinite(parsed.getTime()) || parsed.toISOString()!==recordedAt) throw Error('Date de vente invalide.');
 await tx.runAsync('INSERT INTO sale_event_times(operation_id,recorded_at) VALUES(?,?)',operationId,recordedAt);
}
