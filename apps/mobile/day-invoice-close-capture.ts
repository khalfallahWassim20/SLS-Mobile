/** Capture SQLite expérimentale pour une clôture v6. Non raccordée aux écrans.
 * L'appelant conserve une transaction exclusive et doit envoyer la preuve au
 * serveur : cette capture ne clôture rien et ne prouve pas la caisse physique.
 * Les historiques de vente doivent être complets ; les flux absents du
 * téléphone restent détectables lors de la comparaison serveur. */
import {canonicalJson} from '@sls/domain';
import {dayInvoiceCashClosureCanonical} from '../../packages/domain/src/day-invoice-cash';
import {getDeviceIdentity,type DeviceIdentity} from './identified-device';
import {assertDayInvoiceAttemptsSettled} from './day-invoice-attempt-guard';
import {assertLegacyMobileCreditSafe} from './credit-note-write-guard-prototype';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {readLocalDayInvoiceCash} from './day-invoice-cash';
import {tunisDay} from './journal';
import {readLocalSaleCashLedger} from './credit-sale-refund-journal-prototype';
import type {SavedSale} from './storage';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
function parse(raw:string):any{try{const v=JSON.parse(raw);if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v;}catch{throw Error('Donnée locale illisible : clôture refusée.');}}
export async function captureDayInvoiceClose(tx:Tx,identity:DeviceIdentity,day:string,digest:(text:string)=>Promise<string>){
 const bound=await getDeviceIdentity(tx);if(!bound||bound.commercialId!==identity.commercialId||bound.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur du téléphone incohérent.');
 await assertLegacyMobileCreditSafe(tx,identity);await assertDayInvoiceAttemptsSettled(tx,identity,day);
 const reference=await readDayInvoiceReferenceCache(tx,identity);if(!reference)throw Error('Référence facture du jour indisponible : synchronisez.');
 const pending=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM sales_outbox) OR EXISTS(SELECT 1 FROM journal_sync_outbox)
 OR EXISTS(SELECT 1 FROM day_invoice_payment_outbox) OR EXISTS(SELECT 1 FROM day_invoice_old_debt_outbox) OR EXISTS(SELECT 1 FROM tour_expenses WHERE pending=1)
 OR EXISTS(SELECT 1 FROM tour_expense_revisions WHERE pending=1) OR EXISTS(SELECT 1 FROM tour_expense_cancellations WHERE pending=1)
 OR EXISTS(SELECT 1 FROM credit_remote_sale_confirm_prototype WHERE acknowledged<2) AS n`);
 if(!pending||pending.n)throw Error('Opérations en attente : synchronisez avant clôture.');
 async function origin(kind:'sale'|'journal'|'settlement',entity:string,at:string){
  const rows=await tx.getAllAsync<{operationId:string}>(`SELECT operation_id AS operationId FROM identified_local_operations WHERE operation_kind=? AND entity_id=? AND commercial_id=? AND recorded_at=?`,kind,entity,identity.commercialId,at);
  if(rows.length!==1)throw Error('Origine locale ambiguë : clôture refusée.');return rows[0].operationId;
 }
 const saleRows=await tx.getAllAsync<{id:number;payload:string}>('SELECT id,payload FROM sales ORDER BY id');
 const localSales=saleRows.map(row=>({...parse(row.payload),id:row.id}) as SavedSale);
 const ledger=await readLocalSaleCashLedger(tx,identity,localSales,day),byId=new Map(localSales.map(s=>[s.id,s]));
 const initialEvents:{operationId:string;saleId:string;clientId:string;recordedAt:string;paid:number}[]=[],saleStates:{saleId:string;clientId:string;version:number;total:number;paid:number}[]=[],refundEvents:{operationId:string;saleId:string;clientId:string;recordedAt:string;refund:number}[]=[];
 for(const payment of ledger.initialPayments){const sale=byId.get(payment.saleId);if(!sale?.syncSaleId||!sale.syncVersion)throw Error('Vente locale indisponible.');
  const state=reference.saleStates?.find(s=>s.saleId===sale.syncSaleId);
  if(!state||state.version!==sale.syncVersion||state.clientId!==sale.clientId||state.total!==String(sale.total)||state.paid!==String(sale.paid))throw Error('Vente locale non confirmée par la référence v6.');
  initialEvents.push({operationId:await origin('sale',sale.syncSaleId,sale.createdAt),saleId:sale.syncSaleId,clientId:sale.clientId,recordedAt:sale.createdAt,paid:payment.paid});
  saleStates.push({saleId:sale.syncSaleId,clientId:sale.clientId,version:sale.syncVersion,total:sale.total,paid:sale.paid});
 }
 for(const refund of ledger.refunds){const sale=byId.get(refund.saleId);if(!sale?.syncSaleId||sale.clientId!==refund.clientId)throw Error('Remboursement de vente incohérent.');
  const state=reference.saleStates?.find(s=>s.saleId===sale.syncSaleId);
  if(!state||state.version!==sale.syncVersion||state.clientId!==sale.clientId||state.total!==String(sale.total)||state.paid!==String(sale.paid))throw Error('Remboursement non confirmé par la référence v6.');
  refundEvents.push({operationId:await origin('sale',sale.syncSaleId,refund.recordedAt),saleId:sale.syncSaleId,clientId:sale.clientId,recordedAt:refund.recordedAt,refund:refund.refund});
 }
 const events:any[]=[];
 const invoices=await tx.getAllAsync<{id:string;payload:string}>('SELECT id,payload FROM tour_pre_invoices WHERE journal_date=? ORDER BY id',day);
 for(const row of invoices){const invoice=parse(row.payload),state=await tx.getFirstAsync<{version:number;payload:string}>('SELECT version,payload FROM journal_sync_state WHERE invoice_id=?',row.id);
  const receipts=await tx.getAllAsync<{payload:string}>('SELECT payload FROM tour_journal_receipts WHERE pre_invoice_id=? ORDER BY rowid',row.id);
  if(!state)throw Error('Version de facture locale indisponible.');const snapshot=parse(state.payload),proof=reference.journalProofs.find(p=>p.id===row.id);
  if(invoice.id!==row.id||invoice.journalDate!==day||snapshot.version!==state.version||canonicalJson(snapshot.invoice)!==canonicalJson(invoice)||canonicalJson(snapshot.receipts)!==canonicalJson(receipts.map(r=>parse(r.payload)))||!proof||proof.version!==state.version||await digest(canonicalJson(snapshot))!==proof.hash)throw Error('Facture locale non confirmée par la référence v6.');
  events.push({kind:'invoice',operationId:await origin('journal',invoice.id,invoice.createdAt),invoiceId:invoice.id,clientId:invoice.clientId,recordedAt:invoice.createdAt,amount:invoice.amount});
  for(const item of receipts){const receipt=parse(item.payload);events.push({kind:'receipt',operationId:await origin('journal',invoice.id,receipt.createdAt),invoiceId:invoice.id,receiptId:receipt.id,clientId:receipt.clientId,recordedAt:receipt.createdAt,prePaid:receipt.prePaid,oldDebtPaid:receipt.oldDebtPaid,creditFull:receipt.creditFull,mode:receipt.mode,chequeNumber:receipt.chequeNumber,chequeBank:receipt.chequeBank,chequeDue:receipt.chequeDue});}
 }
 const settlements=await tx.getAllAsync<{payload:string}>('SELECT payload FROM settlements ORDER BY rowid');
 for(const row of settlements){const p=parse(row.payload);if(!Number.isFinite(Date.parse(p.createdAt)))throw Error('Date de règlement locale invalide.');if(tunisDay(new Date(p.createdAt))!==day)continue;
  if(!reference.settlementStates?.some(s=>s.operationId===p.syncOperationId&&s.clientId===p.clientId))throw Error('Règlement non confirmé par la référence v6.');
  const proof=reference.settlementProofs.find(s=>s.operationId===p.syncOperationId);if(!proof||await digest(canonicalJson(p))!==proof.hash)throw Error('Preuve de règlement local incohérente : clôture refusée.');
  events.push({kind:'settlement',operationId:await origin('settlement',p.syncOperationId,p.createdAt),clientId:p.clientId,recordedAt:p.createdAt,amount:p.amount,mode:p.mode,chequeNumber:p.chequeNumber,chequeBank:p.chequeBank,chequeDue:p.chequeDue});
 }
 const dayPayments=await readLocalDayInvoiceCash(tx,identity,day),remote=new Map(reference.dayPayments.map(p=>[p.operationId,p]));
 for(const p of dayPayments)if(canonicalJson(remote.get(p.operationId)??null)!==canonicalJson(p))throw Error('Paiement unifié non confirmé par la référence v6.');
 const invoiceIds=new Set(invoices.map(i=>i.id));
 const ownerDeclarations=reference.dayPayments.filter(p=>p.day===day&&p.preInvoice?.declare&&invoiceIds.has(p.preInvoice.id));
 const sales={version:5 as const,commercialId:identity.commercialId,day,initialEvents,refundEvents,saleStates},journal={version:5 as const,commercialId:identity.commercialId,day,events};
 const cashProof=await digest(dayInvoiceCashClosureCanonical(sales,journal,dayPayments,identity.commercialId,day,ownerDeclarations));if(!/^[0-9a-f]{64}$/.test(cashProof))throw Error('Empreinte de caisse invalide.');
 return {sales,journal,dayPayments,ownerDeclarations,cashProof};
}
