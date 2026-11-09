/** Aperçu administratif isolé. Ne pas monter sur le serveur actif tant que
 * toutes les lectures, écritures et les appareils ne sont pas migrés en v5. */
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {canonicalJson,calculateFullCancellation,calculatePreInvoiceCancellation,summarizePreInvoice,type CreditNoteCommand} from '@sls/domain';
import {assertIdentifiedMode,lockSyncMode} from './tour-sync-mode.js';
import {readPrototypeCreditReferenceInTransaction} from './credit-note-reference-prototype.js';
import {readPrototypeCreditSourcesInTransaction} from './credit-note-sources-prototype.js';
import {JournalConflict} from './journal-store.js';

export const adminCreditCommandSchema=z.object({operationId:z.string().uuid(),invoiceId:z.string().uuid(),expectedVersion:z.number().int().min(1).max(999999),recordedAt:z.string().datetime({precision:3}),choice:z.enum(['refund','credit']).nullable()}).strict();
export const adminCreditInputSchema=z.object({clientId:z.string().uuid(),kind:z.enum(['sale','preinvoice']),command:adminCreditCommandSchema}).strict();
export const adminCreditReviewSchema=z.object({version:z.literal(5),clientId:z.string().uuid(),clientName:z.string().min(1).max(200),kind:z.enum(['sale','preinvoice']),command:adminCreditCommandSchema,sourceHash:z.string().regex(/^[a-f0-9]{64}$/),invoiceDay:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),invoiceTotal:z.number().int().safe().nonnegative(),invoicePaid:z.number().int().safe().nonnegative(),oldDebtPaid:z.number().int().safe().nonnegative(),balanceBefore:z.number().int().safe(),balanceAfter:z.number().int().safe(),refund:z.number().int().safe().nonnegative(),retainedCredit:z.number().int().safe().nonnegative()}).strict();
const day=(date:Date)=>{const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);return ['year','month','day'].map(k=>p.find(x=>x.type===k)?.value).join('-');};
/** Les montants et la source proviennent d'un même instantané serveur, jamais
 * de l'interface ou d'un calcul accepté sans vérification. */
async function calculate(db:PoolClient,input:z.infer<typeof adminCreditInputSchema>) {
 const {clientId,kind,command}=input;
 if(new Date(command.recordedAt).toISOString()!==command.recordedAt||day(new Date(command.recordedAt))!==day(new Date()))throw new JournalConflict('Date de l’avoir périmée : vérifiez à nouveau.');
 const reference=await readPrototypeCreditReferenceInTransaction(db),client=reference.clients.find(c=>c.id===clientId);
 if(!client)throw new JournalConflict('Client introuvable.');
 const sources=await readPrototypeCreditSourcesInTransaction(db,clientId,reference);
 if(!sources||sources.truncated)throw new JournalConflict('Trop de factures pour cet aperçu : sélection plus précise nécessaire.');
 const item=sources.items.find(x=>x.kind===kind&&x.invoiceId===command.invoiceId);
 if(!item||item.version!==command.expectedVersion)throw new JournalConflict('Facture modifiée ou annulée : vérifiez à nouveau.');
 const source=item.source as Record<string,any>,balanceBefore=Number(client.serverBalance);
 if(!Number.isSafeInteger(balanceBefore))throw Error('Solde invalide.');
 let invoiceDay:string,invoiceTotal:number,invoicePaid:number,oldDebtPaid:number,result:{balanceAfter:number;refund:number;retainedCredit:number};
 if(kind==='sale'){
  invoiceDay=day(new Date(source.createdAt));invoiceTotal=source.total;invoicePaid=source.paid;oldDebtPaid=0;
  result=calculateFullCancellation({balance:balanceBefore,invoiceTotal,invoiceNetPaid:invoicePaid,alreadyCancelled:false,choice:command.choice??undefined});
 }else{
  invoiceDay=source.invoice.journalDate;invoiceTotal=source.invoice.amount;
  const summary=summarizePreInvoice(invoiceTotal,source.receipts);invoicePaid=summary.prePaid;oldDebtPaid=summary.oldDebtPaid;
  result=calculatePreInvoiceCancellation({balance:balanceBefore,invoiceTotal,receipts:source.receipts,alreadyCancelled:false,choice:command.choice??undefined});
 }
 return {version:5 as const,clientId,clientName:client.name,kind,command,sourceHash:item.hash,invoiceDay,invoiceTotal,invoicePaid,oldDebtPaid,balanceBefore,balanceAfter:result.balanceAfter,refund:result.refund,retainedCredit:result.retainedCredit};
}
export async function previewAdminCredit(pool:Pool,raw:unknown){
 const input=adminCreditInputSchema.parse(raw),db=await pool.connect();
 try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));const result=await calculate(db,input);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
/** Appelé sous verrou exclusif du protocole et de la facture ; le verrou client
 * bloque aussi une modification concurrente de son solde initial. L'échec est
 * propagé et annule toute la transaction de création. */
export async function assertAdminCreditReview(db:PoolClient,command:CreditNoteCommand,clientId:string,expectedKind:'sale'|'preinvoice',raw:unknown){
 const value=adminCreditReviewSchema.parse(raw);
 const kind=value.kind;if(kind!==expectedKind)throw new JournalConflict('Aperçu invalide.');
 await db.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE',[clientId]);
 const result=await calculate(db,{clientId,kind:expectedKind,command});
 if(canonicalJson(result)!==canonicalJson(value))throw new JournalConflict('Facture ou solde modifié : vérifiez à nouveau l’avoir.');
}
