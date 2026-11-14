/** Envoi ordonné et reprises sûres de la file journal. Aucun jeton n'est conservé ici. */
export type JournalQueueItem = { sequence:number; operationId:string; invoiceId:string; version:number; payload:string };
type JournalResponse = {ok:boolean; status:number; json:()=>Promise<unknown>};
type Sender = (item:JournalQueueItem)=>Promise<JournalResponse>;
export async function uploadJournalQueue(entries:JournalQueueItem[], send:Sender, acknowledge:(entry:JournalQueueItem)=>Promise<void>): Promise<number> {
 let previousSequence=0, sent=0;
 const seen=new Set<string>();
 for(const entry of entries) {
   if(!Number.isSafeInteger(entry.sequence) || entry.sequence<=previousSequence || !Number.isSafeInteger(entry.version) || entry.version<1 || !entry.operationId || seen.has(entry.operationId)) throw new Error('File du journal incohérente.');
   previousSequence=entry.sequence; seen.add(entry.operationId);
   let snapshot: {operationId?:unknown;version?:unknown;invoice?:{id?:unknown}};
   try { snapshot=JSON.parse(entry.payload); } catch { throw new Error('Données du journal en attente illisibles.'); }
   if(!snapshot || snapshot.operationId!==entry.operationId || snapshot.version!==entry.version || snapshot.invoice?.id!==entry.invoiceId) throw new Error('Identifiants du journal en attente incohérents.');
 }
 for(const entry of entries) {
   const response=await send(entry);
   const body:unknown=await response.json().catch(()=>null);
   const data=typeof body==='object' && body!==null ? body as Record<string,unknown> : null;
   if(!response.ok) throw new Error(typeof data?.error==='string' && data.error ? data.error.slice(0,300) : `Erreur journal (${response.status}).`);
   if(!data || (data.status!=='received' && data.status!=='duplicate') || data.operationId!==entry.operationId) throw new Error('Accusé du serveur invalide : la version reste en attente.');
   // En cas de panne pendant l'accusé local, un renvoi conserve le même UUID.
   await acknowledge(entry);
   sent++;
 }
 return sent;
}

type Tx={getFirstAsync<T>(sql:string,...params:(string|number|null)[]):Promise<T|null>;runAsync(sql:string,...params:(string|number|null)[]):Promise<unknown>};
/** À appeler dans une transaction exclusive après contrôle du mode du téléphone. */
export async function acknowledgeJournalQueueEntry(tx:Tx,entry:JournalQueueItem):Promise<void> {
 const row=await tx.getFirstAsync<JournalQueueItem>('SELECT sequence,operation_id AS operationId,invoice_id AS invoiceId,version,payload FROM journal_sync_outbox WHERE operation_id=?',entry.operationId);
 if(!row||row.sequence!==entry.sequence||row.operationId!==entry.operationId||row.invoiceId!==entry.invoiceId||row.version!==entry.version||row.payload!==entry.payload)throw Error('File du journal modifiée : accusé refusé, opération conservée.');
 await tx.runAsync('DELETE FROM journal_sync_outbox WHERE operation_id=?',entry.operationId);
}
