import type {DeviceIdentity} from './identified-device';
import type {TourExpense,ExpenseRevision,ExpenseCancellation} from './tour-expenses';
import {parseClosedDaySyncError} from './identified-upload';

type Pending={originals:TourExpense[];revisions:ExpenseRevision[];cancellations:ExpenseCancellation[]};
type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
type Confirm={original:(entry:TourExpense,receipt:unknown)=>Promise<void>;revision:(entry:ExpenseRevision,receipt:unknown)=>Promise<void>;cancellation:(entry:ExpenseCancellation,receipt:unknown)=>Promise<void>};
/** Les accusés sont contrôlés et enregistrés transactionnellement par l'appelant.
 * Toute erreur interrompt l'envoi ; les entrées non acquittées restent intactes. */
export async function uploadTourExpenses(pending:Pending,identity:DeviceIdentity,send:(path:string,payload:unknown)=>Promise<Response>,confirm:Confirm):Promise<number> {
 const ids=new Set<string>();
 for(const entry of [...pending.originals,...pending.revisions,...pending.cancellations]){
  if(entry.commercialId!==identity.commercialId||entry.serverOrigin!==identity.serverOrigin||entry.pending!==1||ids.has(entry.operationId))throw Error('File de dépenses incohérente : rapprochement nécessaire.');
  ids.add(entry.operationId);
 }
 let count=0;
 async function submit(path:string,payload:unknown,ack:(receipt:unknown)=>Promise<void>,fallback:string){
  const response=await send(path,payload),receipt=await response.json().catch(()=>null);
  if(!response.ok){
   const closed=parseClosedDaySyncError(response.status,receipt);if(closed)throw closed;
   const message=receipt&&typeof receipt==='object'&&!Array.isArray(receipt)&&typeof (receipt as {error?:unknown}).error==='string'?(receipt as {error:string}).error:'';
   throw Error(message?message.slice(0,300):`${fallback} (${response.status}).`);
  }
  await ack(receipt);count++;
 }
 for(const e of pending.originals)await submit('expenses',{operationId:e.operationId,createdAt:e.createdAt,description:e.description,amount:e.amount},r=>confirm.original(e,r),'Envoi de dépense impossible');
 for(const e of pending.revisions){const {operationId,expenseId,version,recordedAt,previousDescription,previousAmount,description,amount}=e;await submit('expense-revisions',{operationId,expenseId,version,recordedAt,previousDescription,previousAmount,description,amount},r=>confirm.revision(e,r),'Correction de dépense impossible');}
 for(const e of pending.cancellations){const {operationId,expenseId,version,recordedAt,description,amount,reason}=e;await submit('expense-cancellations',{operationId,expenseId,version,recordedAt,description,amount,reason},r=>confirm.cancellation(e,r),'Annulation de dépense impossible');}
 return count;
}
