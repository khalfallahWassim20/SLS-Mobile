/** Orchestration expérimentale : après erreur, relire le registre durable
 * avant de permettre une nouvelle saisie ou un nouvel identifiant. */
import {canonicalJson} from '@sls/domain';
import type {PaymentAttempt,StoredPaymentAttempt,confirmDayPaymentAttempt} from './day-invoice-payment-attempt';
export type PaymentAttemptIO={read:()=>Promise<StoredPaymentAttempt|null>;prepare:(attempt:PaymentAttempt)=>Promise<StoredPaymentAttempt>;confirm:(operationId:string)=>Promise<Awaited<ReturnType<typeof confirmDayPaymentAttempt>>>;acknowledge:(operationId:string)=>Promise<void>;cancel:(operationId:string)=>Promise<void>};
const same=(a:PaymentAttempt,b:PaymentAttempt)=>canonicalJson(a)===canonicalJson(b);
export async function resumePaymentAttempt(io:PaymentAttemptIO,attempt:PaymentAttempt){
 const before=await io.read();if(!before||!same(before.attempt,attempt))throw Error('Tentative de règlement absente ou différente.');
 if(!before.result)await io.confirm(attempt.operationId);
 const after=await io.read();if(!after||!after.result||!same(after.attempt,attempt))throw Error('Reçu de règlement indisponible : rapprochement nécessaire.');return after;
}
export async function startPaymentAttempt(io:PaymentAttemptIO,attempt:PaymentAttempt){const prepared=await io.prepare(attempt);if(!same(prepared.attempt,attempt))throw Error('Tentative de règlement différente.');return resumePaymentAttempt(io,attempt);}
export async function finishPaymentAttempt(io:PaymentAttemptIO,attempt:PaymentAttempt){
 const before=await io.read();if(!before||!before.result||!same(before.attempt,attempt))throw Error('Reçu de règlement absent ou différent.');
 try{await io.acknowledge(attempt.operationId);}catch(error){const after=await io.read();if(after)throw error;}
}
export async function abandonPaymentAttempt(io:PaymentAttemptIO,attempt:PaymentAttempt){const before=await io.read();if(!before||before.result||!same(before.attempt,attempt))throw Error('Tentative de règlement non abandonnable.');await io.cancel(attempt.operationId);}
