/** Reprise UI expérimentale : toujours vérifier l'identité exacte de la tentative
 * et son reçu durable avant d'autoriser une nouvelle saisie. */
import {canonicalJson} from '@sls/domain';
import type {SaleEditAttempt,StoredSaleEditAttempt,confirmSaleEditAttempt} from './day-invoice-sale-edit-attempt';
export type SaleEditAttemptIO={read:()=>Promise<StoredSaleEditAttempt|null>;prepare:(attempt:SaleEditAttempt)=>Promise<StoredSaleEditAttempt>;confirm:(id:string)=>Promise<Awaited<ReturnType<typeof confirmSaleEditAttempt>>>;acknowledge:(id:string)=>Promise<void>;cancel:(id:string)=>Promise<void>};
const same=(a:SaleEditAttempt,b:SaleEditAttempt)=>canonicalJson(a)===canonicalJson(b);
export async function startSaleEditAttempt(io:SaleEditAttemptIO,attempt:SaleEditAttempt){
 const prepared=await io.prepare(attempt);if(!same(prepared.attempt,attempt))throw Error('Tentative de modification différente.');
 return resumeSaleEditAttempt(io,attempt);
}
export async function resumeSaleEditAttempt(io:SaleEditAttemptIO,attempt:SaleEditAttempt){
 const before=await io.read();if(!before||!same(before.attempt,attempt))throw Error('Tentative de modification absente ou différente.');
 if(!before.result)await io.confirm(attempt.operationId);
 const after=await io.read();if(!after||!after.result||!same(after.attempt,attempt))throw Error('Reçu de modification indisponible : rapprochement nécessaire.');return after;
}
export async function finishSaleEditAttempt(io:SaleEditAttemptIO,attempt:SaleEditAttempt){
 const before=await io.read();if(!before||!before.result||!same(before.attempt,attempt))throw Error('Reçu de modification absent ou différent.');
 try{await io.acknowledge(attempt.operationId);}catch(error){if(await io.read())throw error;}
}
export async function abandonSaleEditAttempt(io:SaleEditAttemptIO,attempt:SaleEditAttempt){
 const before=await io.read();if(!before||before.result||!same(before.attempt,attempt))throw Error('Modification non abandonnable.');
 await io.cancel(attempt.operationId);
}
