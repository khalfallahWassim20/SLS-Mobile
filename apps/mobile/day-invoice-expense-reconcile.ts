/** Comparaison consultative, sans import ni modification des dépenses. Une
 * égalité à cet instant ne garantit pas qu'un autre téléphone soit synchronisé. */
import {expenseClosureCanonical} from '../../packages/domain/src/day-invoice-expense-proof';
import type {DeviceIdentity} from './identified-device';
import {readLocalExpenseClosureProof} from './day-invoice-expense-proof';
import {acquireDayInvoiceSync,releaseDayInvoiceSync} from './day-invoice-sync-lock';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
type IO={transaction:<T>(work:(tx:Tx)=>Promise<T>)=>Promise<T>;check:()=>void;verifyServer:(identity:DeviceIdentity,check:()=>void)=>Promise<void>;readExpenseSnapshot:(day:string)=>Promise<Response>};
export async function compareDayInvoiceExpenses(identity:DeviceIdentity,verified:DeviceIdentity,day:string,io:IO){
 acquireDayInvoiceSync();
 try{
  const check=()=>{io.check();if(identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur différent du téléphone lié.');};
  check();await io.verifyServer(identity,check);check();
  const capture=()=>io.transaction(async tx=>{check();const result=await readLocalExpenseClosureProof(tx,identity,day);check();return result;});
  const before=await capture(),response=await io.readExpenseSnapshot(day);check();
  if(!response.ok)throw Error(`Dépenses serveur indisponibles (${response.status}).`);
  const remote=await response.json();check();const serverCanonical=expenseClosureCanonical(remote,identity.commercialId,day);
  const after=await capture();check();
  if(before.canonical!==after.canonical)throw Error('Dépenses locales modifiées pendant la comparaison : recommencez.');
  return {matches:after.canonical===serverCanonical,day,localCount:after.snapshot.expenses.length,serverCount:(remote as {expenses:unknown[]}).expenses.length};
 }finally{releaseDayInvoiceSync();}
}
