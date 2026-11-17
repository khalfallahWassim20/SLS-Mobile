/** Vue isolée d'une compensation locale vérifiée. Elle n'actualise pas les
 * anciens soldes ou la clôture et n'atteste pas un versement physique. */
import {selectDayInvoiceExcessPlan} from '../../packages/domain/src/day-invoice-excess-plan';
import type {DeviceIdentity} from './identified-device';
import {readLocalCompensation} from './day-invoice-compensation-local';
import {provePreCompensationSnapshot,readFrozenCompensationReference} from './day-invoice-compensation-snapshot';
import {tunisDay} from './journal';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export async function readLocalCompensationView(tx:Tx,identity:DeviceIdentity){
 const saved=await readLocalCompensation(tx,identity);if(!saved)return null;
 try{
  const {input,receipt}=saved,{event,compensation}=JSON.parse(saved.payload),capture=JSON.parse(input.fingerprint),invoice=JSON.parse(capture.invoice),previous=capture.previous;
  const frozen=await readFrozenCompensationReference(tx,identity,input.operationId,input.fingerprint);
  const before=await provePreCompensationSnapshot(tx,identity,capture,event.sale.clientId,tunisDay(new Date(event.sale.createdAt)),frozen??undefined);
  const source={...invoice.source,dayPayments:invoice.payments.map((p:any)=>({id:p.operationId,amount:p.amount,declaration:p.mode==='Crédit'}))};
  const plan=selectDayInvoiceExcessPlan(source,event.saleId,event.sale.total,capture.balance,input.choice);
  if(!plan.requiresChoice||plan.excess!==compensation.amount||plan.paid!==compensation.paid||plan.previousTotal!==compensation.previousTotal||before.total!==plan.previousTotal||before.paid!==plan.paid||event.sale.clientId!==previous.clientId)throw Error();
  const afterSales=BigInt(before.salesTotal)-BigInt(previous.total)+BigInt(event.sale.total);
  if(afterSales<0n||afterSales>BigInt(Number.MAX_SAFE_INTEGER)||BigInt(before.preInvoiceTotal)+afterSales!==BigInt(plan.total))throw Error();
  const serverBalance=receipt===null?null:(receipt as {projection:{balance:number}}).projection.balance;
  if(serverBalance!==null&&!Number.isSafeInteger(serverBalance))throw Error();
  return {operationId:event.operationId,clientId:event.sale.clientId,commercialId:identity.commercialId,invoiceDay:tunisDay(new Date(event.sale.createdAt)),eventDay:tunisDay(new Date(event.recordedAt)),recordedAt:event.recordedAt,choice:input.choice,previousTotal:plan.previousTotal,total:plan.total,paid:plan.paid,excess:plan.excess,
   localBalanceBefore:plan.balanceBefore,localBalanceAfter:plan.selected.balanceAfter,serverBalanceAtReceipt:serverBalance,balanceNeedsReview:serverBalance===null?null:serverBalance!==plan.selected.balanceAfter,
   preInvoiceTotal:before.preInvoiceTotal,salesTotalBefore:before.salesTotal,salesTotalAfter:Number(afterSales),paidApplied:plan.paid-plan.excess,remaining:0,
   payments:before.payments.map(({operationId,recordedAt,amount,mode,chequeNumber,chequeBank,chequeDue})=>({operationId,recordedAt,amount,mode,chequeNumber,chequeBank,chequeDue})),
   refund:plan.selected.refundAmount,credit:plan.selected.creditAmount,syncStatus:receipt===null?'pending' as const:'proven' as const};
 }catch{throw Error('Vue de compensation incohérente : rapprochement nécessaire.');}
}
/** Impact théorique sur le total encaissé par jour et commercial de saisie,
 * jamais sur les espèces : le moyen et le versement physique ne sont pas prouvés. */
export async function readLocalCompensationCollectionImpact(tx:Tx,identity:DeviceIdentity,commercialId:string,day:string){
 const date=new Date(`${day}T00:00:00.000Z`);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(commercialId))throw Error('Commercial ou journée invalide.');
 const view=await readLocalCompensationView(tx,identity),own=!!view&&view.commercialId===commercialId&&view.eventDay===day;
 return {refund:own?view!.refund:0,credit:own?view!.credit:0,netCollectedChange:own&&view!.refund?-view!.refund:0,operationId:own?view!.operationId:null,syncStatus:own?view!.syncStatus:null};
}
