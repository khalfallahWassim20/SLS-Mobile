/** Inventaire local informatif pour l'aperçu v4→v6, jamais une autorisation.
 * L'appelant détient la transaction exclusive. Aucun état n'est modifié et
 * aucune preuve serveur n'est déduite d'un indicateur local acquitté. */
import type {DeviceIdentity} from './identified-device';
import {readOriginalExpenses,readExpenseRevisions,readExpenseCancellations} from './tour-expenses';
import {findTourCloseAttempt} from './tour-close-queue';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
async function present(tx:Tx,names:string[]){
 const rows=await tx.getAllAsync<{name:string}>("SELECT name FROM sqlite_master WHERE type='table'");
 if(!Array.isArray(rows))throw Error('Inventaire local indisponible.');
 const namesPresent=new Set(rows.map(r=>r.name));return names.every(name=>namesPresent.has(name));
}
export async function readMigrationLocalInventory(tx:Tx,identity:DeviceIdentity,check:()=>void){
 check();
 let expenses:{available:false}|{available:true;originals:number;revisions:number;cancellations:number;pendingOperations:number}={available:false};
 if(await present(tx,['tour_expenses','tour_expense_revisions','tour_expense_cancellations'])){
  const originals=await readOriginalExpenses(tx,identity);check();
  const revisions=await readExpenseRevisions(tx,identity,originals);check();
  const cancellations=await readExpenseCancellations(tx,identity,originals,revisions);check();
  expenses={available:true,originals:originals.length,revisions:revisions.length,cancellations:cancellations.length,pendingOperations:[...originals,...revisions,...cancellations].filter(e=>e.pending===1).length};
 }
 let closures:{available:false}|{available:true;closing:number;closed:number;knownOpen:number;knownClosed:number}={available:false};
 if(await present(tx,['tour_close_attempts','tour_close_cash_proofs','tour_close_admin_refund_proofs','tour_known_server_states'])){
  const attempts=await tx.getAllAsync<{commercialId:string;day:string}>('SELECT commercial_id AS commercialId,journal_date AS day FROM tour_close_attempts');
  let closing=0,closed=0;
  for(const row of attempts){
   if(row.commercialId!==identity.commercialId)throw Error('Clôture liée à un autre commercial : rapprochement nécessaire.');
   const attempt=await findTourCloseAttempt(tx,row.commercialId,row.day);
   if(!attempt||!uuid(attempt.requestId)||!Number.isSafeInteger(attempt.expectedVersion)||attempt.expectedVersion<0||attempt.expectedVersion>=2147483647||(attempt.status==='closing'&&attempt.closedVersion!==null)||(attempt.status==='closed'&&attempt.closedVersion!==attempt.expectedVersion+1)||!['closing','closed'].includes(attempt.status))throw Error('Clôture locale incohérente : rapprochement nécessaire.');
   if(attempt.status==='closing')closing++;else closed++;check();
  }
  const states=await tx.getAllAsync<{commercialId:string;day:string;status:string;version:number}>('SELECT commercial_id AS commercialId,journal_date AS day,status,version FROM tour_known_server_states');
  let knownOpen=0,knownClosed=0;
  for(const state of states){
   const d=new Date(`${state.day}T00:00:00.000Z`);
   if(state.commercialId!==identity.commercialId||!/^\d{4}-\d{2}-\d{2}$/.test(state.day)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==state.day||!Number.isSafeInteger(state.version)||state.version<0||!['open','closed'].includes(state.status))throw Error('État local de clôture incohérent : rapprochement nécessaire.');
   if(state.status==='open')knownOpen++;else knownClosed++;check();
  }
  closures={available:true,closing,closed,knownOpen,knownClosed};
 }
 check();return {expenses,closures};
}
