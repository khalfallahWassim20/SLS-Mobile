import {assertImportedSaleRevision} from './credit-local-revision-audit-prototype';
/** Historique LOCAL v5 : ne prétend pas inclure les opérations d'autres téléphones. */
import type {DeviceIdentity} from './identified-device';
import type {SavedSale,Revision,Settlement,TourJournalReceipt} from './storage';
import {readAbandonedRemoteEditsPrototype,readRecoveredRemoteEditsPrototype} from './credit-remote-sale-confirm-prototype';
import {readCreditClientsPrototype} from './credit-client-view-prototype';
import {readCreditSourcesPrototype} from './credit-note-sources-prototype';
import {readCreditSourceChoices} from './credit-note-source-choices-prototype';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...params:Bind[]):Promise<T[]>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
function parse<T>(payload:string):T {try{const x=JSON.parse(payload);if(!x||typeof x!=='object'||Array.isArray(x))throw Error();return x as T;}catch{throw Error('Historique local illisible.');}}
export async function readCreditHistoryPrototype(tx:Tx,identity:DeviceIdentity,clientId:string,digest:(text:string)=>Promise<string>){
 const snapshot=await readCreditClientsPrototype(tx,identity,digest),client=snapshot.clients.find(c=>c.id===clientId);
 if(!client)throw Error('Client introuvable.');
 const choices=await readCreditSourceChoices(tx,identity,clientId,digest);
 const rows=await tx.getAllAsync<{id:number;payload:string}>('SELECT id,payload FROM sales WHERE client_id=? ORDER BY id DESC',clientId);
 const sales=[];
 for(const row of rows){
  const sale={...parse<Omit<SavedSale,'id'>>(row.payload),id:row.id};
  if(sale.clientId!==clientId)throw Error('Vente locale incohérente.');
  const choice=choices.items.find(x=>x.kind==='sale'&&x.invoiceId===sale.syncSaleId&&x.origin==='local');
  const rs=await tx.getAllAsync<{id:number;created_at:string;previous_payload:string;new_payload:string;refund:number;remoteOperation:string|null;remoteActor:string|null;remoteEvent:string|null;remoteSaleId:string|null}>(`SELECT r.id,r.created_at,r.previous_payload,r.new_payload,r.refund,m.operation_id AS remoteOperation,m.commercial_id AS remoteActor,m.event AS remoteEvent,m.sale_id AS remoteSaleId FROM sale_revisions r LEFT JOIN credit_local_sale_reconcile_prototype m ON m.revision_id=r.id WHERE r.sale_id=? ORDER BY r.id DESC`,row.id);
  const revisions:(Revision&{origin:'local'|'remote';commercialId:string|null;operationId:string|null})[]=rs.map(r=>({id:r.id,createdAt:r.created_at,previous:parse<SavedSale>(r.previous_payload),current:parse<SavedSale>(r.new_payload),refund:r.refund,origin:r.remoteOperation?'remote':'local',commercialId:r.remoteActor,operationId:r.remoteOperation}));
  for(const [i,r] of rs.entries())if(r.remoteOperation){
   if(!sale.syncSaleId||!r.remoteActor||!r.remoteSaleId)throw Error('Historique distant incohérent.');
   assertImportedSaleRevision({operationId:r.remoteOperation,saleId:r.remoteSaleId,actor:r.remoteActor,event:parse<unknown>(r.remoteEvent??''),createdAt:r.created_at,previous:revisions[i].previous,current:revisions[i].current,refund:r.refund},row.id,sale.syncSaleId,clientId);
  }else if(r.remoteActor||r.remoteEvent||r.remoteSaleId)throw Error('Origine de révision incohérente.');
  if(revisions.some(r=>r.previous.id!==row.id||r.current.id!==row.id||r.previous.clientId!==clientId||r.current.clientId!==clientId||!Number.isSafeInteger(r.refund)||r.refund<0))throw Error('Historique de vente incohérent.');
  sales.push({sale,revisions,editable:!!choice&&!choice.blocked&&!client.conflict,blocked:choice?.blocked??(!choice?'rapprochement':null)});
 }
 const settlements=(await tx.getAllAsync<{id:number;payload:string}>('SELECT id,payload FROM settlements WHERE client_id=? ORDER BY id DESC',clientId)).map(r=>({...parse<Omit<Settlement,'id'>>(r.payload),id:r.id}));
 const receipts=(await tx.getAllAsync<{payload:string}>('SELECT payload FROM tour_journal_receipts WHERE client_id=? ORDER BY rowid DESC',clientId)).map(r=>parse<TourJournalReceipt>(r.payload));
 if(settlements.some(p=>p.clientId!==clientId)||receipts.some(p=>p.clientId!==clientId))throw Error('Paiement local incohérent.');
 const sourceCache=await readCreditSourcesPrototype(tx,identity,clientId,digest);
 const remoteSales=choices.items.filter(x=>x.kind==='sale'&&x.origin==='remote').map(x=>{const source=sourceCache?.items.find(s=>s.kind==='sale'&&s.invoiceId===x.invoiceId);if(!source||source.version!==x.version)throw Error('Source distante incohérente.');return {...x,hash:source.hash};});
 const abandonedEdits=await readAbandonedRemoteEditsPrototype(tx,identity,clientId,digest),recoveredEdits=await readRecoveredRemoteEditsPrototype(tx,identity,clientId,digest);
 return {client,identity:{...identity},articles:snapshot.articles,sales,settlements,receipts,remoteSales,abandonedEdits,recoveredEdits,remoteAvailable:choices.remoteAvailable};
}
