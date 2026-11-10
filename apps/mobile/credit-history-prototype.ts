/** Historique LOCAL v5 : ne prétend pas inclure les opérations d'autres téléphones. */
import type {DeviceIdentity} from './identified-device';
import type {SavedSale,Revision,Settlement,TourJournalReceipt} from './storage';
import {readCreditClientsPrototype} from './credit-client-view-prototype';
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
  const rs=await tx.getAllAsync<{id:number;created_at:string;previous_payload:string;new_payload:string;refund:number}>('SELECT id,created_at,previous_payload,new_payload,refund FROM sale_revisions WHERE sale_id=? ORDER BY id DESC',row.id);
  const revisions:Revision[]=rs.map(r=>({id:r.id,createdAt:r.created_at,previous:parse<SavedSale>(r.previous_payload),current:parse<SavedSale>(r.new_payload),refund:r.refund}));
  if(revisions.some(r=>r.previous.id!==row.id||r.current.id!==row.id||r.previous.clientId!==clientId||r.current.clientId!==clientId||!Number.isSafeInteger(r.refund)||r.refund<0))throw Error('Historique de vente incohérent.');
  sales.push({sale,revisions,editable:!!choice&&!choice.blocked&&!client.conflict,blocked:choice?.blocked??(!choice?'rapprochement':null)});
 }
 const settlements=(await tx.getAllAsync<{id:number;payload:string}>('SELECT id,payload FROM settlements WHERE client_id=? ORDER BY id DESC',clientId)).map(r=>({...parse<Omit<Settlement,'id'>>(r.payload),id:r.id}));
 const receipts=(await tx.getAllAsync<{payload:string}>('SELECT payload FROM tour_journal_receipts WHERE client_id=? ORDER BY rowid DESC',clientId)).map(r=>parse<TourJournalReceipt>(r.payload));
 if(settlements.some(p=>p.clientId!==clientId)||receipts.some(p=>p.clientId!==clientId))throw Error('Paiement local incohérent.');
 return {client,identity:{...identity},sales,settlements,receipts};
}
