/** UI expérimentale : une erreur impose la relecture de l'intention durable. */
import {canonicalJson} from '@sls/domain';
import type {NewDayPreinvoice} from './day-invoice-preinvoice-create';
import type {StoredPreinvoiceAttempt,confirmPreinvoiceAttempt} from './day-invoice-preinvoice-attempt';
export type PreinvoiceAttemptIO={read:()=>Promise<StoredPreinvoiceAttempt|null>;prepare:(input:NewDayPreinvoice)=>Promise<StoredPreinvoiceAttempt>;confirm:(id:string)=>Promise<Awaited<ReturnType<typeof confirmPreinvoiceAttempt>>>;acknowledge:(id:string)=>Promise<void>;cancel:(id:string)=>Promise<void>};
const same=(a:NewDayPreinvoice,b:NewDayPreinvoice)=>canonicalJson(a)===canonicalJson(b);
export async function resumePreinvoiceAttempt(io:PreinvoiceAttemptIO,input:NewDayPreinvoice){const before=await io.read();if(!before||!same(before.attempt,input))throw Error('Tentative de préétablie absente ou différente.');if(!before.result)await io.confirm(input.operationId);const after=await io.read();if(!after||!after.result||!same(after.attempt,input))throw Error('Reçu de préétablie indisponible : rapprochement nécessaire.');return after;}
export async function startPreinvoiceAttempt(io:PreinvoiceAttemptIO,input:NewDayPreinvoice){const prepared=await io.prepare(input);if(!same(prepared.attempt,input))throw Error('Tentative de préétablie différente.');return resumePreinvoiceAttempt(io,input);}
export async function finishPreinvoiceAttempt(io:PreinvoiceAttemptIO,input:NewDayPreinvoice){const before=await io.read();if(!before||!before.result||!same(before.attempt,input))throw Error('Reçu de préétablie absent ou différent.');try{await io.acknowledge(input.operationId);}catch(error){if(await io.read())throw error;}}
export async function abandonPreinvoiceAttempt(io:PreinvoiceAttemptIO,input:NewDayPreinvoice){const before=await io.read();if(!before||before.result||!same(before.attempt,input))throw Error('Tentative de préétablie non abandonnable.');await io.cancel(input.operationId);}
