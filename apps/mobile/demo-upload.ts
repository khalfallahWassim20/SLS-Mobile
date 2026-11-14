/** Envoi de démonstration uniquement. Le jeton reste dans l'appelant. */
export type DemoQueueEntry={sequence:number;operationId:string;saleId:string;version:number;payload:string;lastError:string|null};
type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
type Tx={getFirstAsync<T>(sql:string,...args:(string|number|null)[]):Promise<T|null>;runAsync(sql:string,...args:(string|number|null)[]):Promise<unknown>};
const object=(x:unknown):Record<string,unknown>|null=>typeof x==='object'&&x!==null&&!Array.isArray(x)?x as Record<string,unknown>:null;
const uuid=(x:unknown)=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);

/** Prépare toute la file avant le premier envoi, pour éviter des écritures partielles sur file incohérente. */
export function prepareDemoQueue(entries:DemoQueueEntry[]):{entry:DemoQueueEntry;path:'sales'|'settlements'}[]{
 let previous=0;const seen=new Set<string>();
 return entries.map(entry=>{
  if(!Number.isSafeInteger(entry.sequence)||entry.sequence<=previous||!uuid(entry.operationId)||!uuid(entry.saleId)||!Number.isSafeInteger(entry.version)||entry.version<1||seen.has(entry.operationId))throw Error('File de démonstration incohérente : opérations conservées.');
  previous=entry.sequence;seen.add(entry.operationId);
  let payload:Record<string,unknown>|null;try{payload=object(JSON.parse(entry.payload));}catch{throw Error('File de démonstration illisible : opérations conservées.');}
  if(!payload||payload.operationId!==entry.operationId)throw Error('Identifiant de file incohérent : opération conservée.');
  const sale=object(payload.sale),settlement=object(payload.settlement);
  if(sale&&!settlement&&payload.saleId===entry.saleId&&payload.version===entry.version&&sale.syncSaleId===entry.saleId&&sale.syncVersion===entry.version)return {entry,path:'sales'};
  if(settlement&&!sale&&entry.saleId===entry.operationId&&entry.version===1&&settlement.syncOperationId===entry.operationId)return {entry,path:'settlements'};
  throw Error('Contenu de file incohérent : opération conservée.');
 });
}
export async function uploadDemoQueue(entries:DemoQueueEntry[],send:(path:'sales'|'settlements',entry:DemoQueueEntry)=>Promise<Response>,acknowledge:(entry:DemoQueueEntry)=>Promise<void>):Promise<number>{
 const requests=prepareDemoQueue(entries);let count=0;
 for(const {entry,path} of requests){
  const response=await send(path,entry),body=object(await response.json().catch(()=>null));
  if(!response.ok)throw Error(typeof body?.error==='string'&&body.error?body.error.slice(0,300):`Erreur serveur (${response.status}).`);
  if(!body||(body.status!=='reçue'&&body.status!=='déjà reçue')||body.operationId!==entry.operationId)throw Error('Accusé du serveur invalide ou ancien serveur : opération conservée. Mettez à jour le serveur avant de réessayer.');
  await acknowledge(entry);count++;
 }
 return count;
}
/** Appeler dans une transaction exclusive, après contrôle du mode et de l'identité. */
export async function acknowledgeDemoQueueEntry(tx:Tx,entry:DemoQueueEntry):Promise<void>{
 const row=await tx.getFirstAsync<{sequence:number;operationId:string;saleId:string;version:number;payload:string}>(`SELECT sequence,operation_id AS operationId,sale_id AS saleId,version,payload FROM sales_outbox WHERE operation_id=?`,entry.operationId);
 if(!row||row.sequence!==entry.sequence||row.operationId!==entry.operationId||row.saleId!==entry.saleId||row.version!==entry.version||row.payload!==entry.payload)throw Error('File modifiée : accusé refusé, opération conservée.');
 await tx.runAsync('DELETE FROM sales_outbox WHERE operation_id=?',entry.operationId);
}
