/** Vérifie la photographie qui précédait une compensation. Cette photographie
 * ne prouve pas la fraîcheur actuelle du serveur et ne débloque aucun écran
 * historique. Tout est lu sous la même transaction SQLite que le registre. */
import {canonicalJson,summarizePreInvoice} from '@sls/domain';
import {projectDayInvoiceView} from '../../packages/domain/src/day-invoice-view';
import {readDayInvoiceReferenceCache} from './day-invoice-reference-cache';
import {validateDayInvoiceReference} from './day-invoice-reference';
import type {DeviceIdentity} from './identified-device';
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;runAsync(sql:string,...args:Bind[]):Promise<unknown>};
export const dayInvoiceCompensationSnapshotSchema=`CREATE TABLE IF NOT EXISTS day_invoice_compensation_snapshots (
 operation_id TEXT PRIMARY KEY, commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL,
 fingerprint TEXT NOT NULL, reference_payload TEXT NOT NULL
);`;
/** Copie atomique de la référence ayant servi à confirmer le choix. Elle reste
 * distincte du cache courant et ne constitue pas une preuve de fraîcheur. */
export async function freezeCompensationReference(tx:Tx,identity:DeviceIdentity,operationId:string,fingerprint:string){
 const reference=await readDayInvoiceReferenceCache(tx,identity);
 const row=await tx.getFirstAsync<{commercialId:string;serverOrigin:string;payload:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,payload FROM day_invoice_reference_cache WHERE id=1');
 if(!reference||!row||row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin)throw Error('Référence de compensation indisponible.');
 await tx.runAsync('INSERT INTO day_invoice_compensation_snapshots(operation_id,commercial_id,server_origin,fingerprint,reference_payload) VALUES(?,?,?,?,?)',operationId,identity.commercialId,identity.serverOrigin,fingerprint,row.payload);
}
/** Les anciennes compensations sans copie continuent à utiliser leur cache
 * historique, dont le remplacement reste interdit par la garde existante. */
export async function readFrozenCompensationReference(tx:Tx,identity:DeviceIdentity,operationId:string,fingerprint:string){
 const row=await tx.getFirstAsync<{commercialId:string;serverOrigin:string;fingerprint:string;payload:string}>('SELECT commercial_id AS commercialId,server_origin AS serverOrigin,fingerprint,reference_payload AS payload FROM day_invoice_compensation_snapshots WHERE operation_id=?',operationId);
 if(!row)return null;
 if(row.commercialId!==identity.commercialId||row.serverOrigin!==identity.serverOrigin||row.fingerprint!==fingerprint)throw Error('Photographie de compensation incohérente.');
 try{return validateDayInvoiceReference(JSON.parse(row.payload));}catch{throw Error('Référence de compensation illisible.');}
}
export async function provePreCompensationSnapshot(tx:Tx,identity:DeviceIdentity,capture:any,clientId:string,day:string,frozen?:ReturnType<typeof validateDayInvoiceReference>){
 const ref=frozen??await readDayInvoiceReferenceCache(tx,identity);
 if(!ref||!ref.saleStates||!ref.journalStates||!Number.isSafeInteger(capture?.balance))throw Error('Référence de compensation indisponible.');
 const client=ref.clients.find(c=>c.id===clientId);
 if(!client||client.serverBalance==null||!Number.isSafeInteger(Number(client.serverBalance))||Number(client.serverBalance)!==capture.balance)throw Error('Solde de la capture différent de la référence.');
 const sales=ref.saleStates.filter(s=>s.clientId===clientId&&ref.saleDays.some(d=>d.saleId===s.saleId&&d.day===day)).map(s=>({id:s.saleId,version:s.version,total:Number(s.total),paid:Number(s.paid)})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 const candidates=ref.journalStates.filter(p=>p.clientId===clientId&&p.journalDate===day);
 if(candidates.length>1)throw Error('Factures préétablies ambiguës.');
 const item=candidates[0];let preInvoice:null|{id:string;version:number;total:number;paid:number;declared:boolean}=null;
 if(item){const proof=ref.journalProofs.find(p=>p.id===item.id);if(!proof)throw Error('Preuve de facture absente.');const summary=summarizePreInvoice(item.total,item.receipts);if(sales.length&&summary.oldDebtPaid>0)throw Error('Ancienne dette ambiguë.');preInvoice={id:item.id,version:proof.version,total:item.total,paid:summary.prePaid,declared:summary.declared||ref.declaredByDayPayment.includes(item.id)};}
 if(ref.settlementDays.some(p=>p.clientId===clientId&&(ref.oldDebtMarkers.some(m=>m.operationId===p.operationId)?day<p.day:p.day===day)))throw Error('Règlement global non attribué.');
 const source={clientId,day,preInvoice,sales},invoice=JSON.parse(capture.invoice);
 const payments=ref.dayPayments.filter(p=>p.clientId===clientId&&p.day===day).sort((a,b)=>a.recordedAt<b.recordedAt?-1:a.recordedAt>b.recordedAt?1:a.operationId<b.operationId?-1:a.operationId>b.operationId?1:0);
 if(canonicalJson(invoice.source)!==canonicalJson(source)||canonicalJson(invoice.payments)!==canonicalJson(payments))throw Error('Sources ou paiements de la capture différents de la référence.');
 return projectDayInvoiceView(source,[],payments);
}
