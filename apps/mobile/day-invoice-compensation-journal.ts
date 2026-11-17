/** Lecture expérimentale du journal serveur après une compensation prouvée.
 * Ne remplace ni le journal local, ni un solde, ni une clôture. */
import {canonicalJson} from '@sls/domain';
import type {DeviceIdentity} from './identified-device';
import {acquireDayInvoiceSync,releaseDayInvoiceSync} from './day-invoice-sync-lock';
import {readLocalCompensation,readLocalCompensationById} from './day-invoice-compensation-local';
import {readLocalCompensationView} from './day-invoice-compensation-view';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
type IO={transaction:<T>(work:(tx:Tx)=>Promise<T>)=>Promise<T>;check:()=>void;verifyServer:(identity:DeviceIdentity,check:()=>void)=>Promise<void>;read:(operationId:string)=>Promise<{ok:boolean;status:number;json:()=>Promise<unknown>}>};
export type CompensatedJournalRow={clientId:string;clientName:string;sector:string;preInvoiceTotal:number;salesTotal:number;totalClient:number;dayInvoicePaid:number;oldDebtPaid:number;totalCollected:number;refund:number;credit:number;theoreticalNet:number};
export type CompensatedJournal={version:1;operationId:string;commercialId:string;day:string;clientId:string;totalBilled:number;totalCollected:number;refund:number;credit:number;theoreticalNet:number;rows:CompensatedJournalRow[]};
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const obj=(x:unknown):x is Record<string,any>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const nonnegative=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
export function validateCompensatedJournal(value:unknown,expected:{operationId:string;commercialId:string;clientId:string;day:string;refund:number;credit:number}):CompensatedJournal{
 if(!obj(value)||Object.keys(value).sort().join(',')!=='clientId,commercialId,credit,day,operationId,refund,rows,theoreticalNet,totalBilled,totalCollected,version'||value.version!==1||value.operationId!==expected.operationId||value.commercialId!==expected.commercialId||value.clientId!==expected.clientId||value.day!==expected.day||!uuid(value.operationId)||!uuid(value.commercialId)||!uuid(value.clientId)||!Array.isArray(value.rows)||value.rows.length>10000)throw Error('Journal serveur incohérent.');
 if(![value.totalBilled,value.totalCollected,value.refund,value.credit].every(nonnegative)||!Number.isSafeInteger(value.theoreticalNet)||BigInt(value.totalCollected)-BigInt(value.refund)!==BigInt(value.theoreticalNet))throw Error('Totaux du journal incohérents.');
 const ids=new Set<string>();let billed=0n,refund=0n,credit=0n;let own:CompensatedJournalRow|undefined;
 for(const row of value.rows){
  if(!obj(row)||Object.keys(row).sort().join(',')!=='clientId,clientName,credit,dayInvoicePaid,oldDebtPaid,preInvoiceTotal,refund,salesTotal,sector,theoreticalNet,totalClient,totalCollected'||!uuid(row.clientId)||ids.has(row.clientId.toLowerCase())||typeof row.clientName!=='string'||!row.clientName.trim()||row.clientName.length>200||typeof row.sector!=='string'||row.sector.length>200||![row.preInvoiceTotal,row.salesTotal,row.totalClient,row.dayInvoicePaid,row.oldDebtPaid,row.totalCollected,row.refund,row.credit].every(nonnegative)||!Number.isSafeInteger(row.theoreticalNet)||BigInt(row.preInvoiceTotal)+BigInt(row.salesTotal)!==BigInt(row.totalClient)||BigInt(row.totalCollected)-BigInt(row.refund)!==BigInt(row.theoreticalNet))throw Error('Ligne du journal incohérente.');
  ids.add(row.clientId.toLowerCase());billed+=BigInt(row.totalClient);refund+=BigInt(row.refund);credit+=BigInt(row.credit);if(row.clientId===expected.clientId)own=row as CompensatedJournalRow;
 }
 if(billed!==BigInt(value.totalBilled)||refund!==BigInt(value.refund)||credit!==BigInt(value.credit)||!own||own.refund!==expected.refund||own.credit!==expected.credit)throw Error('Compensation du journal incohérente.');
 return value as CompensatedJournal;
}
export async function readVerifiedCompensatedJournal(identity:DeviceIdentity,verified:DeviceIdentity,io:IO,operationId?:string){
 acquireDayInvoiceSync();try{
  const check=()=>{io.check();if(identity.commercialId!==verified.commercialId||identity.serverOrigin!==verified.serverOrigin)throw Error('Session ou serveur différent du téléphone lié.');};
  check();await io.verifyServer(identity,check);check();
  const readLocal=()=>io.transaction(async tx=>{check();const saved=operationId===undefined?await readLocalCompensation(tx,identity):await readLocalCompensationById(tx,identity,operationId),view=await readLocalCompensationView(tx,identity,operationId);check();if(!saved||!view||saved.receipt===null||view.syncStatus!=='proven')throw Error('Reçu de compensation indisponible : synchronisez d’abord.');return {saved,view};});
  const before=await readLocal(),response=await io.read(before.view.operationId);check();if(!response.ok)throw Error(`Journal serveur indisponible (${response.status}).`);
  const body=await response.json();check();const view=before.view;
  const result=validateCompensatedJournal(body,{operationId:view.operationId,commercialId:identity.commercialId,clientId:view.clientId,day:view.eventDay,refund:view.refund,credit:view.credit});
  const after=await readLocal();check();if(canonicalJson(before)!==canonicalJson(after))throw Error('Compensation locale modifiée : rapprochement nécessaire.');return result;
 }finally{releaseDayInvoiceSync();}
}
