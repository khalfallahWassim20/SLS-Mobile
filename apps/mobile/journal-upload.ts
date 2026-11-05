/** Envoi ordonné et reprises sûres de la file journal. Aucun jeton n'est conservé ici. */
export type JournalQueueItem = { sequence:number; operationId:string; invoiceId:string; version:number; payload:string };
type JournalResponse = {ok:boolean; status:number; json:()=>Promise<unknown>};
type Sender = (item:JournalQueueItem)=>Promise<JournalResponse>;
export async function uploadJournalQueue(entries:JournalQueueItem[], send:Sender, acknowledge:(operationId:string)=>Promise<void>): Promise<number> {
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
   await acknowledge(entry.operationId);
   sent++;
 }
 return sent;
}
