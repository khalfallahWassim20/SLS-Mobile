import {summarizePreInvoice,type JournalSyncReceipt} from './journal.ts';
import {calculatePreInvoiceCancellation} from './pre-invoice-credit-note.ts';
import type {FullCreditChoice} from './credit-note.ts';

/** Préparation non branchée à la référence mobile actuelle. Le solde serveur et
 * ses états doivent venir du même instantané transactionnel. Une annulation
 * reçue au serveur est déjà incluse dans ce solde. */
export type CreditJournalState={id:string;version:number;total:number;receipts:JournalSyncReceipt[];creditNote:null|{operationId:string;expectedVersion:number;choice:FullCreditChoice|null;recordedAt:string;actor:{id:string;role:'admin'|'commercial'}}};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
function receiptEqual(a:JournalSyncReceipt,b:JournalSyncReceipt){return a.id===b.id&&a.prePaid===b.prePaid&&a.oldDebtPaid===b.oldDebtPaid&&a.creditFull===b.creditFull;}
function validate(states:CreditJournalState[]) {
 if(!Array.isArray(states))throw new RangeError('États du journal invalides');
 const ids=new Set<string>(),receipts=new Set<string>(),notes=new Set<string>();
 for(const state of states) {
  if(!state||!uuid(state.id)||ids.has(state.id)||!Number.isSafeInteger(state.version)||state.version<1||state.version>=1000000||!Array.isArray(state.receipts))throw new RangeError('État de facture du journal invalide ou dupliqué');
  ids.add(state.id);
  for(const r of state.receipts) {
   if(!r||!uuid(r.id)||receipts.has(r.id))throw new RangeError('Règlement du journal invalide ou dupliqué');
   receipts.add(r.id);
  }
  summarizePreInvoice(state.total,state.receipts);
  const n=state.creditNote;
  if(n!==null) {
   if(!n||!uuid(n.operationId)||notes.has(n.operationId)||n.expectedVersion!==state.version||!n.actor||!['admin','commercial'].includes(n.actor.role)||typeof n.actor.id!=='string'||!n.actor.id.trim()||n.actor.id.length>200||(n.actor.role==='commercial'&&!uuid(n.actor.id))||![null,'refund','credit'].includes(n.choice)||typeof n.recordedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(n.recordedAt)||!Number.isFinite(Date.parse(n.recordedAt))||new Date(n.recordedAt).toISOString()!==n.recordedAt)throw new RangeError('Avoir du journal invalide ou dupliqué');
   notes.add(n.operationId);
   calculatePreInvoiceCancellation({balance:0,invoiceTotal:state.total,receipts:state.receipts,alreadyCancelled:false,choice:n.choice??undefined});
  }
 }
}
function effect(state:CreditJournalState):bigint {
 const before=summarizePreInvoice(state.total,state.receipts);
 const delta=state.creditNote?calculatePreInvoiceCancellation({balance:0,invoiceTotal:state.total,receipts:state.receipts,alreadyCancelled:false,choice:state.creditNote.choice??undefined}).balanceDelta:0;
 return BigInt(before.debtEffect)+BigInt(delta);
}
function sameNote(a:NonNullable<CreditJournalState['creditNote']>,b:NonNullable<CreditJournalState['creditNote']>){return a.operationId===b.operationId&&a.expectedVersion===b.expectedVersion&&a.choice===b.choice&&a.recordedAt===b.recordedAt&&a.actor.role===b.actor.role&&a.actor.id===b.actor.id;}
/** L'effet local est ajouté uniquement si sa version prolonge l'état serveur.
 * Un avoir différent, une version périmée ou une divergence historique renvoie
 * conflict=true : l'appelant doit bloquer les opérations, jamais l'ignorer. */
export function reconcilePreInvoiceCredits(serverBalance:number,local:CreditJournalState[],server:CreditJournalState[]) {
 if(!Number.isSafeInteger(serverBalance))throw new RangeError('Solde serveur invalide');
 validate(local);validate(server);
 const remote=new Map(server.map(s=>[s.id,s])),owners=new Map(server.flatMap(s=>s.receipts.map(r=>[r.id,s.id] as const)));
 const noteOwners=new Map(server.filter(s=>s.creditNote!==null).map(s=>[s.creditNote!.operationId,s.id] as const));
 let conflict=local.some(s=>s.receipts.some(r=>owners.has(r.id)&&owners.get(r.id)!==s.id) || (s.creditNote!==null&&noteOwners.has(s.creditNote.operationId)&&noteOwners.get(s.creditNote.operationId)!==s.id)),balance=BigInt(serverBalance);
 for(const state of local) {
  const existing=remote.get(state.id);
  if(!existing){balance+=effect(state);continue;}
  const prefix=existing.total===state.total&&existing.version<=state.version&&existing.receipts.length<=state.receipts.length&&state.version-existing.version===state.receipts.length-existing.receipts.length&&existing.receipts.every((r,i)=>receiptEqual(r,state.receipts[i]));
  if(!prefix){conflict=true;continue;}
  if(existing.creditNote) {
   if(!state.creditNote||state.version!==existing.version||!sameNote(state.creditNote,existing.creditNote)){conflict=true;continue;}
   // Le solde serveur contient déjà l'effet ; ne jamais le compter deux fois.
   continue;
  }
  balance+=effect(state)-effect(existing);
 }
 if(balance>BigInt(Number.MAX_SAFE_INTEGER)||balance<BigInt(Number.MIN_SAFE_INTEGER))throw new RangeError('Solde trop élevé');
 return {balance:Number(balance),conflict};
}
