/** Projection de la facture du jour à partir du cache vérifié et des données
 * locales. Préparatoire : elle ne remplace pas les contrôles sous transaction
 * ni les arbitrages du serveur lorsque plusieurs téléphones sont hors ligne. */
import {canonicalJson,summarizePreInvoice} from '@sls/domain';
import {projectDayInvoiceView} from '../../packages/domain/src/day-invoice-view';
import type {DayInvoicePayment} from '../../packages/domain/src/day-invoice';
import type {readLocalDayInvoiceSource} from './day-invoice-local';
import type {validateDayInvoiceReference} from './day-invoice-reference';
type Local=Awaited<ReturnType<typeof readLocalDayInvoiceSource>>;
type Reference=ReturnType<typeof validateDayInvoiceReference>;
export function buildMergedDayInvoiceView(reference:Reference,local:Local,localPayments:readonly DayInvoicePayment[]) {
 const {clientId,day}=local;
 if(!reference.clients.some(c=>c.id===clientId)||!reference.saleStates||!reference.journalStates)throw Error('Client ou référence indisponible.');
 if(reference.settlementDays.some(p=>p.clientId===clientId&&(reference.oldDebtMarkers.some(m=>m.operationId===p.operationId)?day<p.day:p.day===day)))throw Error('Règlement global non attribué sur cette journée : rapprochement nécessaire.');
 const remoteSales=reference.saleStates.filter(s=>s.clientId===clientId&&reference.saleDays.some(d=>d.saleId===s.saleId&&d.day===day));
 const sales=new Map<string,{id:string;version:number;total:number;paid:number}>();
 for(const sale of remoteSales)sales.set(sale.saleId,{id:sale.saleId,version:sale.version,total:Number(sale.total),paid:Number(sale.paid)});
 const localIds=new Set<string>();
 for(const sale of local.sales){
  if(localIds.has(sale.id))throw Error('Vente locale dupliquée.');localIds.add(sale.id);
  const known=reference.saleStates.find(s=>s.saleId===sale.id),date=reference.saleDays.find(d=>d.saleId===sale.id);
  if(known&&(known.clientId!==clientId||date?.day!==day||known.version!==sale.version||Number(known.total)!==sale.total||Number(known.paid)!==sale.paid))throw Error('Vente locale et serveur incohérentes.');
  sales.set(sale.id,sale);
 }
 const candidates=reference.journalStates.filter(p=>p.clientId===clientId&&p.journalDate===day);
 if(candidates.length>1)throw Error('Factures serveur en conflit.');
 const remote=candidates[0],proof=remote?reference.journalProofs.find(p=>p.id===remote.id):undefined;
 if(remote&&!proof)throw Error('Preuve de facture indisponible.');
 const remoteSummary=remote?summarizePreInvoice(remote.total,remote.receipts):null;
 if(local.preInvoice&&remote&&(local.preInvoice.id!==remote.id||local.preInvoice.total!==remote.total||local.preInvoice.version!==proof!.version||canonicalJson(local.receiptProof)!==canonicalJson(remote.receipts)))throw Error('Facture locale et serveur incohérentes.');
 if(sales.size&&(local.oldDebtPaid>0||(remoteSummary?.oldDebtPaid??0)>0))throw Error('Règlement historique non attribué : rapprochement nécessaire.');
 let pre=local.preInvoice;
 if(remote&&remoteSummary){
  const declared=remoteSummary.declared||reference.declaredByDayPayment.includes(remote.id)||localPayments.some(p=>p.preInvoice?.id===remote.id&&p.preInvoice.declare);
  pre={id:remote.id,version:proof!.version,total:remote.total,paid:remoteSummary.prePaid,declared:declared||(pre?.declared??false)};
 }
 if(localPayments.length!==local.dayPayments.length||localPayments.some(p=>!local.dayPayments.some(q=>q.id===p.operationId&&q.amount===p.amount)))throw Error('Paiements locaux incohérents.');
 const remotePayments=reference.dayPayments.filter(p=>p.clientId===clientId&&p.day===day);
 const source={clientId,day,preInvoice:pre,sales:[...sales.values()]};
 const view=projectDayInvoiceView(source,localPayments,remotePayments);
 return {...view,source,remoteOnlySaleIds:remoteSales.filter(s=>!localIds.has(s.saleId)).map(s=>s.saleId),remoteOnlyPreInvoice:!!remote&&!local.preInvoice};
}
