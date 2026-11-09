/** Calcul de solde futur : non utilisé par les écrans actuels. La référence,
 * les factures locales et les avoirs doivent être lus dans des transactions
 * cohérentes ; en cas de conflit, l'appelant doit bloquer les opérations. */
import {canonicalJson,prepareFullCreditNote,calculatePreInvoiceCancellation,reconcileSaleCredits,reconcilePreInvoiceCredits,type CreditJournalState,type JournalSyncReceipt} from '@sls/domain';
import type {Note} from './credit-note-offline-prototype';
import type {validatePrototypeCreditReference} from './credit-note-reference-prototype';
type Reference=ReturnType<typeof validatePrototypeCreditReference>;
type Sale={id?:number;clientId:string;syncSaleId?:string;syncVersion?:number;total:number;paid:number;[key:string]:unknown};
type Journal={id:string;clientId:string;journalDate:string;version:number;total:number;receipts:JournalSyncReceipt[];snapshot:unknown};
type Settlement={clientId:string;syncOperationId?:string;amount:number};
export function prototypeCreditBalance(input:{clientId:string;identity:{commercialId:string;serverOrigin:string};reference:Reference;sales:Sale[];journals:Journal[];settlements:Settlement[];notes:Note[];verifiedRemoteSales?:ReadonlySet<string>;verifiedRemoteJournals?:ReadonlySet<string>}) {
 const {clientId,reference}=input,client=reference.clients.find(c=>c.id===clientId);
 if(!client?.serverBalance)throw Error('Solde serveur indisponible.');
 const saleIds=new Set<string>(),journalIds=new Set<string>(),receiptIds=new Set<string>(),settlementIds=new Set<string>();
 for(const s of input.sales)if(s.syncSaleId){if(saleIds.has(s.syncSaleId))throw Error('Vente locale dupliquée.');saleIds.add(s.syncSaleId);}
 for(const j of input.journals){
  if(journalIds.has(j.id))throw Error('Facture locale dupliquée.');journalIds.add(j.id);
  for(const r of j.receipts){if(receiptIds.has(r.id))throw Error('Règlement de journal dupliqué.');receiptIds.add(r.id);}
 }
 const remoteSettlements=new Map(reference.settlementStates?.map(s=>[s.operationId,s.clientId])??[]);
 let paymentConflict=false;
 for(const p of input.settlements)if(p.syncOperationId){
  if(settlementIds.has(p.syncOperationId))throw Error('Règlement local dupliqué.');settlementIds.add(p.syncOperationId);
  if(remoteSettlements.has(p.syncOperationId)&&remoteSettlements.get(p.syncOperationId)!==p.clientId)paymentConflict=true;
 }
 const noteByEntity=new Map<string,Note>(),noteIds=new Set<string>();
 const remoteNotes=new Map<string,string>();
 for(const s of reference.saleStates)if(s.creditNote)remoteNotes.set(s.creditNote.command.operationId,`sale:${s.saleId}`);
 for(const j of reference.journalStates)if(j.creditNote)remoteNotes.set(j.creditNote.operationId,`preinvoice:${j.id}`);
 for(const note of input.notes){
  if(note.commercialId!==input.identity.commercialId||note.serverOrigin!==input.identity.serverOrigin)throw Error('Identité de l’avoir incohérente.');
  const key=`${note.kind}:${note.command.invoiceId}`;
  if(noteByEntity.has(key)||noteIds.has(note.command.operationId))throw Error('Avoir local dupliqué.');
  noteIds.add(note.command.operationId);
  if((remoteNotes.has(note.command.operationId)&&remoteNotes.get(note.command.operationId)!==key)||remoteSettlements.has(note.command.operationId)||settlementIds.has(note.command.operationId))paymentConflict=true;
  const source=note.source as {clientId?:unknown;invoice?:{clientId?:unknown}}|null;
  const owner=note.kind==='sale'?source?.clientId:source?.invoice?.clientId;
  const entities=note.kind==='sale'?input.sales.filter(s=>s.syncSaleId===note.command.invoiceId):input.journals.filter(j=>j.id===note.command.invoiceId);
  if(typeof owner!=='string'||entities.length!==1||entities[0].clientId!==owner)throw Error('Facture locale d’un avoir introuvable ou incohérente.');
  noteByEntity.set(key,note);
 }
 const remoteSales=new Map(reference.saleStates.map(s=>[s.saleId,s]));
 let conflict=paymentConflict;
 const sales=input.sales.filter(s=>s.clientId===clientId).map(s=>{
  const remote=s.syncSaleId?remoteSales.get(s.syncSaleId):undefined;
  if(remote&&remote.clientId!==clientId)conflict=true;
  const note=s.syncSaleId?noteByEntity.get(`sale:${s.syncSaleId}`):undefined;
  if(!note)return {...s,creditNote:remote?.creditNote&&s.syncSaleId&&input.verifiedRemoteSales?.has(s.syncSaleId)?remote.creditNote:null};
  const {id:_id,...current}=s;
  if(canonicalJson(current)!==canonicalJson(note.source))throw Error('Vente locale modifiée après avoir.');
  const event=prepareFullCreditNote({actor:{id:note.commercialId,role:'commercial'},command:note.command,source:{invoiceId:note.command.invoiceId,version:s.syncVersion!,total:s.total,netPaid:s.paid,cancelled:false},daysOpen:true,previous:null}).event;
  if(event.balanceDelta!==note.balanceDelta||event.refund!==note.refund||event.retainedCredit!==note.retainedCredit)throw Error('Montants de l’avoir local incohérents.');
  return {...s,creditNote:event};
 });
 const serverSales=reference.saleStates.filter(s=>s.clientId===clientId).map(s=>({...s,total:Number(s.total),paid:Number(s.paid)}));
 const paid=reference.settlementStates?.filter(p=>p.clientId===clientId).map(p=>p.operationId)??[];
 const localPayments=input.settlements.filter(p=>p.clientId===clientId);
 const salesBalance=reconcileSaleCredits({serverBalance:Number(client.serverBalance),localSales:sales,serverSales,localSettlements:localPayments,serverSettlementIds:paid});
 const remoteJournals=new Map(reference.journalStates.map(s=>[s.id,s]));
 const remoteReceipts=new Map(reference.journalStates.flatMap(s=>s.receipts.map(r=>[r.id,s.id] as const)));
 const localJournals:CreditJournalState[]=input.journals.filter(j=>j.clientId===clientId).map(j=>{
  const remote=remoteJournals.get(j.id);if(remote&&remote.clientId!==clientId)conflict=true;
  if(reference.journalStates.some(r=>r.clientId===clientId&&r.journalDate===j.journalDate&&r.id!==j.id)||j.receipts.some(r=>remoteReceipts.has(r.id)&&remoteReceipts.get(r.id)!==j.id))conflict=true;
  const snapshot=j.snapshot as {version?:number;invoice?:{id?:string;clientId?:string;journalDate?:string;amount?:number};receipts?:JournalSyncReceipt[]}|null;
  if(!snapshot||snapshot.version!==j.version||snapshot.invoice?.id!==j.id||snapshot.invoice.clientId!==j.clientId||snapshot.invoice.journalDate!==j.journalDate||snapshot.invoice.amount!==j.total||!Array.isArray(snapshot.receipts)||canonicalJson(snapshot.receipts.map(r=>({id:r.id,prePaid:r.prePaid,oldDebtPaid:r.oldDebtPaid,creditFull:r.creditFull})))!==canonicalJson(j.receipts.map(r=>({id:r.id,prePaid:r.prePaid,oldDebtPaid:r.oldDebtPaid,creditFull:r.creditFull}))))throw Error('État local du journal incohérent.');
  const note=noteByEntity.get(`preinvoice:${j.id}`);
  if(note&&canonicalJson(note.source)!==canonicalJson(j.snapshot))throw Error('Facture locale modifiée après avoir.');
  if(note){const calculated=calculatePreInvoiceCancellation({balance:0,invoiceTotal:j.total,receipts:j.receipts,alreadyCancelled:false,choice:note.command.choice??undefined});if(calculated.balanceDelta!==note.balanceDelta||calculated.refund!==note.refund||calculated.retainedCredit!==note.retainedCredit)throw Error('Montants de l’avoir local incohérents.');}
  return {id:j.id,version:j.version,total:j.total,receipts:j.receipts,creditNote:note?{operationId:note.command.operationId,expectedVersion:note.command.expectedVersion,recordedAt:note.command.recordedAt,choice:note.command.choice,actor:{id:note.commercialId,role:'commercial'}}:remote?.creditNote&&input.verifiedRemoteJournals?.has(j.id)?remote.creditNote:null};
 });
 const journalBalance=reconcilePreInvoiceCredits(salesBalance.balance,localJournals,reference.journalStates.filter(s=>s.clientId===clientId));
 return {balance:journalBalance.balance,conflict:conflict||salesBalance.conflict||journalBalance.conflict};
}
