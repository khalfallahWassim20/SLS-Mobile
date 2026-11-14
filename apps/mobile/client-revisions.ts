/** Une seule lecture protégée pour tout l'historique d'un client. */
import {readLegacyRows} from './legacy-read-guard';
import type {Revision} from './storage';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
export async function readClientRevisions(tx:Tx,clientId:string):Promise<Revision[]> {
 const rows=await readLegacyRows<{id:number;created_at:string;previous_payload:string;new_payload:string;refund:number}>(tx,`SELECT r.id,r.created_at,r.previous_payload,r.new_payload,r.refund
  FROM sale_revisions r JOIN sales s ON s.id=r.sale_id WHERE s.client_id=? ORDER BY r.created_at DESC,r.id DESC`,clientId);
 return rows.map(r=>({id:r.id,createdAt:r.created_at,previous:JSON.parse(r.previous_payload),current:JSON.parse(r.new_payload),refund:r.refund}));
}
