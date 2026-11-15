/** Orchestration UI du parcours expérimental. Les écritures restent dans les
 * transactions exclusives de l'adaptateur ; une erreur n'autorise pas une
 * nouvelle tentative avant relecture du registre durable. */
import {canonicalJson} from '@sls/domain';
import type {NewSaleAttempt} from './day-invoice-sale-create-input';
import type {readDaySaleAttempt,confirmDaySaleAttempt} from './day-invoice-sale-attempt';
export type StoredSaleAttempt=NonNullable<Awaited<ReturnType<typeof readDaySaleAttempt>>>;
export type SaleAttemptIO={read:()=>Promise<StoredSaleAttempt|null>;prepare:(attempt:NewSaleAttempt)=>Promise<StoredSaleAttempt>;confirm:(operationId:string)=>Promise<Awaited<ReturnType<typeof confirmDaySaleAttempt>>>;acknowledge:(operationId:string)=>Promise<void>;cancel:(operationId:string)=>Promise<void>};
function same(a:NewSaleAttempt,b:NewSaleAttempt){return canonicalJson(a)===canonicalJson(b);}
export async function startSaleAttempt(io:SaleAttemptIO,attempt:NewSaleAttempt):Promise<StoredSaleAttempt>{
 const prepared=await io.prepare(attempt);if(!same(prepared.attempt,attempt))throw Error('Tentative de vente différente : rapprochement nécessaire.');
 return resumeSaleAttempt(io,attempt);
}
export async function resumeSaleAttempt(io:SaleAttemptIO,attempt:NewSaleAttempt):Promise<StoredSaleAttempt>{
 const before=await io.read();if(!before||!same(before.attempt,attempt))throw Error('Tentative de vente absente ou différente.');
 if(!before.result)await io.confirm(attempt.operationId);
 const after=await io.read();if(!after||!after.result||!same(after.attempt,attempt))throw Error('Reçu de vente indisponible : rapprochement nécessaire.');return after;
}
export async function finishSaleAttempt(io:SaleAttemptIO,attempt:NewSaleAttempt):Promise<void>{
 const before=await io.read();if(!before||!before.result||!same(before.attempt,attempt))throw Error('Reçu de vente absent ou différent.');
 try{await io.acknowledge(attempt.operationId);}catch(error){
  // Le reçu avait été vérifié avant l'accusé ; son absence après une erreur
  // est compatible avec une suppression commise malgré une réponse perdue.
  const after=await io.read();if(after)throw error;
 }
}
export async function abandonSaleAttempt(io:SaleAttemptIO,attempt:NewSaleAttempt):Promise<void>{
 const before=await io.read();if(!before||before.result||!same(before.attempt,attempt))throw Error('Tentative de vente non abandonnable.');
 await io.cancel(attempt.operationId);
}
