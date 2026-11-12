import {canonicalJson} from '@sls/domain';
import {assertImportedSaleRevision} from './credit-local-revision-audit-prototype';
import {tunisDay} from './journal';
import type {DeviceIdentity} from './identified-device';
import type {SavedSale} from './storage';

type Bind=string|number|null;
type Tx={getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>};
export type LocalSaleRefund={revisionId:number;saleId:number;clientId:string;clientName:string;recordedAt:string;refund:number};
export type InitialSalePayment={saleId:number;paid:number};
function parseSale(raw:string):SavedSale {try{const v=JSON.parse(raw);if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v;}catch{throw Error('Historique de vente illisible.');}}
/** Reconstruit le paiement initial et les sorties locales de chaque journée.
 * La facture reste à sa dernière version pour l'avoir. Les révisions importées
 * ont été remboursées ailleurs et ne constituent pas une sortie de ce téléphone. */
export async function readLocalSaleCashLedger(tx:Tx,identity:DeviceIdentity,sales:SavedSale[],day:string):Promise<{initialPayments:InitialSalePayment[];refunds:LocalSaleRefund[]}> {
 const initialPayments:InitialSalePayment[]=[],refunds:LocalSaleRefund[]=[];
 for(const sale of sales){
  if(!sale.syncSaleId||!Number.isSafeInteger(sale.syncVersion)||sale.syncVersion!<1)throw Error('Vente locale non identifiée : rapprochement nécessaire avant journal.');
  const rows=await tx.getAllAsync<{revisionId:number;createdAt:string;previous:string;current:string;refund:number;operationId:string|null;remoteSaleId:string|null;actor:string|null;event:string|null}>(`SELECT r.id AS revisionId,r.created_at AS createdAt,r.previous_payload AS previous,r.new_payload AS current,r.refund,
   m.operation_id AS operationId,m.sale_id AS remoteSaleId,m.commercial_id AS actor,m.event
   FROM sale_revisions r LEFT JOIN credit_local_sale_reconcile_prototype m ON m.revision_id=r.id WHERE r.sale_id=? ORDER BY r.id`,sale.id);
  if(!Number.isFinite(Date.parse(sale.createdAt))||rows.some(r=>!Number.isFinite(Date.parse(r.createdAt))||!Number.isSafeInteger(r.refund)||r.refund<0))throw Error('Historique de vente illisible : journal refusé.');
  const originDay=tunisDay(new Date(sale.createdAt));
  const affectsDay=originDay===day||rows.some(r=>r.refund>0&&Number.isFinite(Date.parse(r.createdAt))&&tunisDay(new Date(r.createdAt))===day);
  if(!affectsDay)continue;
  if(rows.length!==sale.syncVersion!-1)throw Error('Historique local de vente incomplet : rapprochement nécessaire.');
  let previous:SavedSale|undefined,first:SavedSale=sale,previousAt=Date.parse(sale.createdAt);
  if(!Number.isFinite(previousAt))throw Error('Date de vente invalide.');
  const origin=await tx.getFirstAsync<{n:number}>(`SELECT COUNT(*) AS n FROM identified_local_operations WHERE operation_kind='sale' AND entity_id=? AND commercial_id=? AND recorded_at=?`,sale.syncSaleId,identity.commercialId,sale.createdAt);
  if(origin?.n!==1)throw Error('Origine locale de la vente non prouvée ou ambiguë.');
  const localTimes=new Set([sale.createdAt]);
  for(const [i,r] of rows.entries()){
   const before=parseSale(r.previous),after=parseSale(r.current),at=Date.parse(r.createdAt);
   if(!Number.isSafeInteger(r.revisionId)||r.revisionId<1||!Number.isFinite(at)||at<previousAt||before.id!==sale.id||after.id!==sale.id||before.clientId!==sale.clientId||after.clientId!==sale.clientId||before.syncSaleId!==sale.syncSaleId||after.syncSaleId!==sale.syncSaleId||before.createdAt!==sale.createdAt||after.createdAt!==sale.createdAt||before.syncVersion!==i+1||after.syncVersion!==i+2||!Number.isSafeInteger(before.paid)||before.paid<0||!Number.isSafeInteger(after.paid)||after.paid<0||!Number.isSafeInteger(after.total)||after.total<0||!Number.isSafeInteger(r.refund)||r.refund<0||before.paid-r.refund!==after.paid||r.refund>Math.max(0,before.paid-after.total)||(previous&&canonicalJson(previous)!==canonicalJson(before)))throw Error('Historique de vente incohérent : journal refusé.');
   if(i===0)first=before;
   if(r.operationId){
    let event:unknown;try{event=JSON.parse(r.event??'');}catch{throw Error('Historique distant incohérent.');}
    assertImportedSaleRevision({operationId:r.operationId,saleId:r.remoteSaleId!,actor:r.actor!,event,createdAt:r.createdAt,previous:before,current:after,refund:r.refund},sale.id,sale.syncSaleId,sale.clientId);
   }else{
    const marker=await tx.getFirstAsync<{n:number}>(`SELECT COUNT(*) AS n FROM identified_local_operations WHERE operation_kind='sale' AND entity_id=? AND commercial_id=? AND recorded_at=?`,sale.syncSaleId,identity.commercialId,r.createdAt);
    if(marker?.n!==1||localTimes.has(r.createdAt))throw Error('Origine de la révision locale non prouvée ou ambiguë.');
    localTimes.add(r.createdAt);
    if(r.refund>0&&tunisDay(new Date(r.createdAt))===day)refunds.push({revisionId:r.revisionId,saleId:sale.id,clientId:sale.clientId,clientName:after.clientName,recordedAt:r.createdAt,refund:r.refund});
   }
   previous=after;previousAt=at;
  }
  if(previous&&canonicalJson(previous)!==canonicalJson(sale))throw Error('Dernière version locale de vente incohérente.');
  if(!Number.isSafeInteger(first.paid)||first.paid<0||!Number.isSafeInteger(first.total)||first.paid>first.total)throw Error('Paiement initial de vente incohérent.');
  if(tunisDay(new Date(sale.createdAt))===day)initialPayments.push({saleId:sale.id,paid:first.paid});
 }
 return {initialPayments,refunds};
}
