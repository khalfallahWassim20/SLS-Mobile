/** Référentiel et soldes v5 destinés aux futurs écrans mobile uniquement.
 * La transaction doit rester exclusive jusqu'à la fin de la capture. */
import {isSaleBlocked} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import {loadCreditBalanceSnapshotPrototype} from './credit-note-balance-storage-prototype';
import {readAllOfflineCreditPrototype} from './credit-note-offline-prototype';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
/** Ne convertit jamais la référence en v3 et ne retourne aucun prix d'achat.
 * En cas de conflit, le solde est null et toutes les écritures sont interdites. */
export async function readCreditClientsPrototype(tx:Tx,identity:DeviceIdentity,digest:(text:string)=>Promise<string>){
 const snapshot=await loadCreditBalanceSnapshotPrototype(tx,identity,digest),reference=snapshot.reference;
 const notes=await readAllOfflineCreditPrototype(tx,identity);
 const clientIds=new Set(reference.clients.map(client=>client.id));
 const localClients=await tx.getAllAsync<{clientId:string}>(`SELECT client_id AS clientId FROM sales UNION SELECT client_id AS clientId FROM settlements UNION SELECT client_id AS clientId FROM tour_pre_invoices`);
 if(localClients.some(row=>!clientIds.has(row.clientId)))throw Error('Client d’une opération locale absent de la référence : rapprochement nécessaire.');
 for(const {note} of notes){const source=note.source as {clientId?:unknown;invoice?:{clientId?:unknown}},id=note.kind==='sale'?source.clientId:source.invoice?.clientId;if(typeof id!=='string'||!clientIds.has(id))throw Error('Client d’un avoir absent de la référence : rapprochement nécessaire.');}
 const pending=await tx.getFirstAsync<{sales:number;journals:number}>(`SELECT (SELECT count(*) FROM sales_outbox) AS sales,(SELECT count(*) FROM journal_sync_outbox) AS journals`);
 if(!pending||!Number.isSafeInteger(pending.sales)||!Number.isSafeInteger(pending.journals)||!Number.isSafeInteger(pending.sales+pending.journals)||pending.sales<0||pending.journals<0)throw Error('Files de synchronisation indisponibles.');
 const clients=[];
 for(const client of reference.clients){
  const limit=Number(client.creditLimit),serverBalance=Number(client.serverBalance),result=snapshot.balanceFor(client.id);
  if(!Number.isSafeInteger(limit)||limit<0||!Number.isSafeInteger(serverBalance))throw Error('Solde ou limite client invalide.');
  const balance=result.conflict?null:result.balance,blocked=balance===null||isSaleBlocked(balance,limit,false);
  clients.push({id:client.id,name:client.name,sector:client.sector,active:client.active,limit,serverBalance,balance,conflict:result.conflict,
   saleBlocked:!client.active||blocked,blockReason:!client.active?'client-inactif' as const:balance===null?'conflit' as const:blocked?'limite' as const:null,
   canSettle:balance!==null&&balance>0});
 }
 return {version:5 as const,identity:{...identity},clients,articles:reference.articles.map(a=>({...a})),pendingOperations:pending.sales+pending.journals,pendingCredits:notes.filter(n=>n.pending).length};
}
