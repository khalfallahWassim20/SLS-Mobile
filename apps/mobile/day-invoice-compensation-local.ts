/** Écriture SQLite expérimentale, non montée dans l'application. Le registre
 * conserve l'historique même après reçu serveur ; les anciens calculs doivent
 * rester bloqués tant qu'ils ne savent pas projeter la compensation. Toutes
 * les fonctions exigent une transaction SQLite exclusive de l'appelant. */
import {canonicalJson,calculateInvoice} from '@sls/domain';
import {assessDayInvoiceSaleRevision} from '../../packages/domain/src/day-invoice';
import {captureDayInvoiceSaleEdit} from './day-invoice-sale-edit';
import {assertDayInvoiceAttemptExclusive} from './day-invoice-attempt-guard';
import {assertDayInvoiceSyncIdle} from './day-invoice-sync-lock';
import {getDeviceIdentity,assertDeviceWritable,recordDeviceOperation,type DeviceIdentity} from './identified-device';
import {recordSaleEventTime} from './sale-event-time';
import {verifyCompensationReceipt} from './day-invoice-compensation-upload';
import {tunisDay} from './journal';
import type {SavedSale} from './storage';

type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export type LocalCompensationInput={saleId:number;lines:SavedSale['lines'];fingerprint:string;operationId:string;recordedAt:string;choice:'refund'|'credit'};
type Input=LocalCompensationInput;
type Row={operationId:string;saleId:number;commercialId:string;serverOrigin:string;input:string;payload:string;receipt:string|null};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const dayInvoiceCompensationLocalSchema=`CREATE TABLE IF NOT EXISTS day_invoice_compensation_local (
 operation_id TEXT PRIMARY KEY, sale_id INTEGER NOT NULL, commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL,
 input TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT
);`;
async function bound(tx:Tx,identity:DeviceIdentity){const actual=await getDeviceIdentity(tx);if(!actual||actual.commercialId!==identity.commercialId||actual.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur incohérent.');}
/** Relit et vérifie chaque copie avant toute reprise ou acquittement. */
export async function readLocalCompensation(tx:Tx,identity:DeviceIdentity):Promise<{input:Input;payload:string;receipt:unknown|null}|null>{
 await bound(tx,identity);
 const rows=await tx.getAllAsync<Row>('SELECT operation_id AS operationId,sale_id AS saleId,commercial_id AS commercialId,server_origin AS serverOrigin,input,payload,receipt FROM day_invoice_compensation_local LIMIT 2');
 if(!rows.length)return null;if(rows.length!==1)throw Error('Compensations locales ambiguës.');
 const r=rows[0];let input:Input,stored:any,receipt:unknown|null;
 try{input=JSON.parse(r.input);stored=JSON.parse(r.payload);receipt=r.receipt===null?null:JSON.parse(r.receipt);
  if(!input||Object.keys(input).sort().join(',')!=='choice,fingerprint,lines,operationId,recordedAt,saleId'||!Number.isSafeInteger(input.saleId)||input.saleId<1||!uuid.test(input.operationId)||typeof input.recordedAt!=='string'||!Number.isFinite(Date.parse(input.recordedAt))||new Date(input.recordedAt).toISOString()!==input.recordedAt||!['refund','credit'].includes(input.choice)||!Array.isArray(input.lines)||!input.lines.length||input.lines.length>200||r.operationId!==input.operationId||r.saleId!==input.saleId||r.commercialId!==identity.commercialId||r.serverOrigin!==identity.serverOrigin)throw Error();
  const capture=JSON.parse(input.fingerprint),invoice=JSON.parse(capture.invoice),previous=capture.previous;
  const total=calculateInvoice(input.lines.map(l=>({quantity:l.quantity,unitPrice:l.unitPrice,discountRate:l.discount,vatRate:l.vat}))).total;
  const assessed=assessDayInvoiceSaleRevision({...invoice.source,dayPayments:invoice.payments.map((p:any)=>({id:p.operationId,amount:p.amount,declaration:p.mode==='Crédit'}))},previous.syncSaleId,total);
  const updated={...previous,lines:input.lines,total,remaining:Math.max(0,total-previous.paid),syncVersion:previous.syncVersion+1}, {id:_id,...sale}=updated;
  const event={operationId:input.operationId,saleId:previous.syncSaleId,version:updated.syncVersion,recordedAt:input.recordedAt,sale,refund:0};
  const compensation={choice:input.choice,amount:assessed.excess,previousTotal:assessed.previousTotal,paid:assessed.paid};
  if(!assessed.requiresChoice||assessed.paid>assessed.previousTotal||canonicalJson(capture.lines)!==canonicalJson(input.lines)||canonicalJson(stored)!==canonicalJson({event,compensation})||previous.id!==input.saleId||Date.parse(input.recordedAt)<=Date.parse(previous.createdAt)||invoice.payments.some((p:any)=>Date.parse(p.recordedAt)>Date.parse(input.recordedAt)))throw Error();
  const saleRow=await tx.getFirstAsync<{clientId:string;payload:string}>('SELECT client_id AS clientId,payload FROM sales WHERE id=?',input.saleId);
  const revisions=await tx.getAllAsync<{previous:string;current:string;refund:number}>('SELECT previous_payload AS previous,new_payload AS current,refund FROM sale_revisions WHERE sale_id=? AND created_at=?',input.saleId,input.recordedAt);
  const marker=await tx.getFirstAsync<{commercialId:string;kind:string;entityId:string;recordedAt:string}>('SELECT commercial_id AS commercialId,operation_kind AS kind,entity_id AS entityId,recorded_at AS recordedAt FROM identified_local_operations WHERE operation_id=?',input.operationId);
  const time=await tx.getFirstAsync<{recordedAt:string}>('SELECT recorded_at AS recordedAt FROM sale_event_times WHERE operation_id=?',input.operationId);
  if(!saleRow||saleRow.clientId!==previous.clientId||canonicalJson(JSON.parse(saleRow.payload))!==canonicalJson(sale)||revisions.length!==1||revisions[0].refund!==0||canonicalJson(JSON.parse(revisions[0].previous))!==canonicalJson(previous)||canonicalJson(JSON.parse(revisions[0].current))!==canonicalJson(updated)||!marker||marker.commercialId!==identity.commercialId||marker.kind!=='sale'||marker.entityId!==event.saleId||marker.recordedAt!==input.recordedAt||time?.recordedAt!==input.recordedAt)throw Error();
  if(receipt!==null)verifyCompensationReceipt(stored,receipt,identity.commercialId);
 }catch{throw Error('Preuve de compensation locale incohérente : rapprochement nécessaire.');}
 return {input,payload:r.payload,receipt};
}
/** Révision et choix sur une seule transaction ; aucune file historique de
 * vente ne doit envoyer séparément cette révision sans sa compensation. */
export async function confirmLocalCompensation(tx:Tx,identity:DeviceIdentity,input:Input,digest:(text:string)=>Promise<string>){
 const existing=await readLocalCompensation(tx,identity);
 if(existing){if(canonicalJson(existing.input)!==canonicalJson(input))throw Error('Une compensation différente existe déjà : rapprochement nécessaire.');return {status:'duplicate' as const,...existing};}
 if(!input||!Number.isSafeInteger(input.saleId)||input.saleId<1||!uuid.test(input.operationId)||!['refund','credit'].includes(input.choice)||typeof input.recordedAt!=='string'||!Number.isFinite(Date.parse(input.recordedAt))||new Date(input.recordedAt).toISOString()!==input.recordedAt)throw Error('Choix ou date de compensation invalide.');
 assertDayInvoiceSyncIdle();await assertDayInvoiceAttemptExclusive(tx,identity);
 const current=await captureDayInvoiceSaleEdit(tx,identity,input.saleId,input.lines,digest),previous=current.previous;
 if(current.fingerprint!==input.fingerprint)throw Error('Facture ou solde modifié : vérifiez à nouveau.');
 if(!current.assessment.requiresChoice||!current.excessPlan||!current.excessPlan.options.some(o=>o.choice===input.choice))throw Error('Compensation non justifiée.');
 if(Date.parse(input.recordedAt)<=Date.parse(previous.createdAt))throw Error('Date de révision invalide.');
 const captured=JSON.parse(input.fingerprint),invoice=JSON.parse(captured.invoice);
 if(invoice.payments.some((p:any)=>Date.parse(p.recordedAt)>Date.parse(input.recordedAt)))throw Error('Modification antérieure à un paiement.');
 await assertDeviceWritable(tx,identity,[current.day,tunisDay(new Date(input.recordedAt))]);
 const taken=await tx.getFirstAsync<{n:number}>(`SELECT EXISTS(SELECT 1 FROM identified_local_operations WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM sales_outbox WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM journal_sync_outbox WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_payments WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM day_invoice_old_debt_local WHERE lower(operation_id)=lower(?)) OR EXISTS(SELECT 1 FROM offline_credit_prototype WHERE lower(operation_id)=lower(?)) AS n`,input.operationId,input.operationId,input.operationId,input.operationId,input.operationId,input.operationId);
 if(!taken||taken.n)throw Error('Identifiant de révision déjà utilisé.');
 const last=await tx.getFirstAsync<{createdAt:string}>('SELECT created_at AS createdAt FROM sale_revisions WHERE sale_id=? ORDER BY id DESC LIMIT 1',input.saleId);
 if(last&&Date.parse(input.recordedAt)<=Date.parse(last.createdAt))throw Error('Date de révision non chronologique.');
 const total=current.assessment.total-current.assessment.previousTotal+previous.total;
 const updated={...previous,lines:current.lines,total,remaining:Math.max(0,total-previous.paid),syncVersion:previous.syncVersion!+1},{id:_id,...sale}=updated;
 const event={operationId:input.operationId,saleId:previous.syncSaleId,version:updated.syncVersion,recordedAt:input.recordedAt,sale,refund:0};
 const compensation={choice:input.choice,amount:current.assessment.excess,previousTotal:current.assessment.previousTotal,paid:current.assessment.paid},payload=JSON.stringify({event,compensation});
 await tx.runAsync('UPDATE sales SET payload=? WHERE id=?',JSON.stringify(sale),input.saleId);
 await tx.runAsync('INSERT INTO sale_revisions(sale_id,created_at,previous_payload,new_payload,refund) VALUES(?,?,?,?,0)',input.saleId,input.recordedAt,JSON.stringify(previous),JSON.stringify(updated));
 await recordSaleEventTime(tx,input.operationId,input.recordedAt);await recordDeviceOperation(tx,identity,input.operationId,'sale',previous.syncSaleId!,input.recordedAt);
 await tx.runAsync('INSERT INTO day_invoice_compensation_local(operation_id,sale_id,commercial_id,server_origin,input,payload,receipt) VALUES(?,?,?,?,?,?,NULL)',input.operationId,input.saleId,identity.commercialId,identity.serverOrigin,JSON.stringify(input),payload);
 const saved=await readLocalCompensation(tx,identity);if(!saved)throw Error('Preuve locale indisponible.');return {status:'created' as const,...saved};
}
/** Garder la preuve, et refuser toute file changée pendant le transfert. */
export async function acknowledgeLocalCompensation(tx:Tx,identity:DeviceIdentity,payload:string,receipt:unknown){
 const current=await readLocalCompensation(tx,identity);if(!current||current.payload!==payload)throw Error('File de compensation modifiée : accusé refusé.');
 verifyCompensationReceipt(JSON.parse(payload),receipt,identity.commercialId);
 if(current.receipt!==null&&canonicalJson(current.receipt)!==canonicalJson(receipt))throw Error('Reçu de compensation différent.');
 if(current.receipt===null)await tx.runAsync('UPDATE day_invoice_compensation_local SET receipt=? WHERE operation_id=?',JSON.stringify(receipt),current.input.operationId);
}
