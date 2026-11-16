/** Lecture en ligne expérimentale d'une compensation existante. Elle ne
 * remplace aucune référence locale et ne lève aucune garde de clôture. */
import {canonicalJson} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import {acquireDayInvoiceSync,releaseDayInvoiceSync} from './day-invoice-sync-lock';
import {readLocalCompensation} from './day-invoice-compensation-local';
import {readLocalCompensationView} from './day-invoice-compensation-view';
import {verifyCompensationReceipt} from './day-invoice-compensation-upload';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
type IO={transaction:<T>(work:(tx:Tx)=>Promise<T>)=>Promise<T>;check:()=>void;verifyServer:(identity:DeviceIdentity,check:()=>void)=>Promise<void>;read:(operationId:string)=>Promise<Response>};
const obj=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export async function reconcileCompensatedInvoice(identity:DeviceIdentity,verified:DeviceIdentity,io:IO){
 acquireDayInvoiceSync();
 try{
  const check=()=>{io.check();if(identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur différent du téléphone lié.');};
  check();await io.verifyServer(identity,check);check();
  const readLocal=()=>io.transaction(async tx=>{check();const saved=await readLocalCompensation(tx,identity),view=await readLocalCompensationView(tx,identity);check();if(!saved||!view||saved.receipt===null||view.syncStatus!=='proven')throw Error('Reçu de compensation indisponible : synchronisez d’abord.');return {saved,view};});
  const before=await readLocal();check();const response=await io.read(before.view.operationId);check();
  if(!response.ok)throw Error(`Facture serveur indisponible (${response.status}).`);
  const body=await response.json();check();
  try{
   if(!obj(body)||Object.keys(body).sort().join(',')!=='compensation,invoice,journal,version'||body.version!==2||!obj(body.invoice)||!obj(body.compensation)||!obj(body.journal))throw Error();
   const invoice=body.invoice,p=body.compensation,journal=body.journal,expected=JSON.parse(before.saved.payload),captured=JSON.parse(before.saved.input.fingerprint),localInvoice=JSON.parse(captured.invoice);
   if(Object.keys(invoice).sort().join(',')!=='applied,clientId,day,paid,payments,preInvoiceTotal,remaining,salesTotal,total'||!Array.isArray(invoice.payments))throw Error();
   verifyCompensationReceipt(expected,{event:expected.event,compensation:expected.compensation,projection:p},identity.commercialId);
   const v=before.view;
   if(invoice.clientId!==v.clientId||invoice.day!==v.invoiceDay||invoice.preInvoiceTotal!==v.preInvoiceTotal||invoice.salesTotal!==v.salesTotalAfter||invoice.total!==v.total||invoice.paid!==v.paid||invoice.applied!==v.paidApplied||invoice.remaining!==v.remaining||canonicalJson(invoice.payments)!==canonicalJson(localInvoice.payments))throw Error();
   const keys='clientGross,clientId,clientTheoreticalNet,commercialId,credit,day,gross,refund,theoreticalNet';
   if(Object.keys(journal).sort().join(',')!==keys||journal.commercialId!==identity.commercialId||journal.clientId!==v.clientId||journal.day!==v.eventDay||journal.refund!==v.refund||journal.credit!==v.credit||![journal.gross,journal.theoreticalNet,journal.clientGross,journal.clientTheoreticalNet].every(Number.isSafeInteger)||BigInt(journal.gross)-BigInt(journal.refund)!==BigInt(journal.theoreticalNet)||BigInt(journal.clientGross)-BigInt(journal.refund)!==BigInt(journal.clientTheoreticalNet))throw Error();
   const after=await readLocal();check();
   if(canonicalJson(after.saved)!==canonicalJson(before.saved)||canonicalJson(after.view)!==canonicalJson(before.view))throw Error();
   return {operationId:v.operationId,clientId:v.clientId,day:v.invoiceDay,total:v.total,paid:v.paid,applied:v.paidApplied,remaining:v.remaining,balance:p.balance as number,balanceNeedsReview:p.balance!==v.localBalanceAfter,journal:{day:journal.day as string,gross:journal.gross as number,refund:journal.refund as number,credit:journal.credit as number,theoreticalNet:journal.theoreticalNet as number,clientGross:journal.clientGross as number,clientTheoreticalNet:journal.clientTheoreticalNet as number}};
  }catch{throw Error('Facture serveur et photographie locale divergentes : rapprochement nécessaire.');}
 }finally{releaseDayInvoiceSync();}
}
