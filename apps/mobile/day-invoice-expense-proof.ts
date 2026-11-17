/** Lecture préparatoire de la preuve des dépenses. À appeler dans une
 * transaction exclusive ; ne ferme pas la tournée et ne modifie aucune file. */
import {expenseClosureCanonical,type ExpenseProofSnapshot} from '../../packages/domain/src/day-invoice-expense-proof';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {readOriginalExpenses,readExpenseRevisions,readExpenseCancellations} from './tour-expenses';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export async function readLocalExpenseClosureProof(tx:Tx,identity:DeviceIdentity,day:string){
 const actual=await getDeviceIdentity(tx);
 if(!actual||actual.commercialId!==identity.commercialId||actual.serverOrigin!==identity.serverOrigin)throw Error('Identité du téléphone incohérente.');
 const originals=await readOriginalExpenses(tx,identity),revisions=await readExpenseRevisions(tx,identity,originals),cancellations=await readExpenseCancellations(tx,identity,originals,revisions);
 if(originals.some(e=>e.pending)||revisions.some(e=>e.pending)||cancellations.some(e=>e.pending))throw Error('Synchronisez les dépenses avant comparaison.');
 const byExpense=new Map<string,typeof revisions>(),cancelByExpense=new Map(cancellations.map(c=>[c.expenseId,c]));
 for(const r of revisions){const list=byExpense.get(r.expenseId)??[];list.push(r);byExpense.set(r.expenseId,list);}
 const snapshot:ExpenseProofSnapshot={version:1,commercialId:identity.commercialId,day,expenses:originals.filter(e=>e.day===day).map(e=>{
  const c=cancelByExpense.get(e.operationId);
  return {operationId:e.operationId,createdAt:e.createdAt,description:e.description,amount:e.amount,revisions:(byExpense.get(e.operationId)??[]).map(r=>({operationId:r.operationId,version:r.version,recordedAt:r.recordedAt,previousDescription:r.previousDescription,previousAmount:r.previousAmount,description:r.description,amount:r.amount})),cancellation:c?{operationId:c.operationId,version:c.version,recordedAt:c.recordedAt,description:c.description,amount:c.amount,reason:c.reason}:null};
 })};
 return {snapshot,canonical:expenseClosureCanonical(snapshot,identity.commercialId,day)};
}
