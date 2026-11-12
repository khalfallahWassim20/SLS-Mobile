import type {SavedSale} from './storage';
import {tunisDay} from './journal';

type Tx={getAllAsync<T>(sql:string,...args:(string|number|null)[]):Promise<T[]>};
export type LocalSaleRefund={revisionId:number;saleId:number;clientId:string;clientName:string;recordedAt:string;refund:number};
function parseSale(raw:string):SavedSale{try{const v=JSON.parse(raw);if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v;}catch{throw Error('Historique de remboursement illisible.');}}
/** Chaque paiement de vente étant projeté à sa dernière version au jour de
 * création, ne pas publier les deux journées si un remboursement est daté
 * d'un autre jour. Un remboursement local le jour même est déjà inclus dans
 * le paiement net et n'est jamais déduit une seconde fois. */
export async function readLocalSaleRefundsForJournal(tx:Tx,sales:SavedSale[],day:string):Promise<LocalSaleRefund[]> {
 const rows=await tx.getAllAsync<{revisionId:number;saleId:number;createdAt:string;previous:string;current:string;refund:number;imported:number}>(`SELECT r.id AS revisionId,r.sale_id AS saleId,r.created_at AS createdAt,r.previous_payload AS previous,r.new_payload AS current,r.refund,
  EXISTS(SELECT 1 FROM credit_local_sale_reconcile_prototype m WHERE m.revision_id=r.id) AS imported
  FROM sale_revisions r WHERE r.refund<>0 ORDER BY r.id`);
 const byId=new Map(sales.map(s=>[s.id,s])),result:LocalSaleRefund[]=[];
 for(const r of rows){
  const sale=byId.get(r.saleId),previous=parseSale(r.previous),current=parseSale(r.current),created=new Date(r.createdAt);
  if(!sale||!Number.isSafeInteger(r.revisionId)||r.revisionId<1||!Number.isSafeInteger(r.refund)||r.refund<=0||!Number.isFinite(created.getTime())||previous.id!==sale.id||current.id!==sale.id||previous.clientId!==sale.clientId||current.clientId!==sale.clientId||previous.syncSaleId!==sale.syncSaleId||current.syncSaleId!==sale.syncSaleId||previous.createdAt!==sale.createdAt||current.createdAt!==sale.createdAt||typeof current.clientName!=='string'||!current.clientName.trim()||(sale.syncSaleId&&(!Number.isSafeInteger(previous.syncVersion)||!Number.isSafeInteger(current.syncVersion)||!Number.isSafeInteger(sale.syncVersion)||previous.syncVersion!+1!==current.syncVersion||current.syncVersion!>sale.syncVersion!))||!Number.isSafeInteger(previous.paid)||previous.paid<0||!Number.isSafeInteger(current.paid)||current.paid<0||!Number.isSafeInteger(current.total)||current.total<0||previous.paid-r.refund!==current.paid||r.refund>Math.max(0,previous.paid-current.total)||![0,1].includes(r.imported))throw Error('Historique de remboursement incohérent : export refusé.');
  const invoiceDay=tunisDay(new Date(sale.createdAt)),refundDay=tunisDay(created);
  if(invoiceDay!==refundDay&&(day===invoiceDay||day===refundDay))throw Error('Remboursement sur une autre journée : rapprochement des encaissements nécessaire avant journal ou clôture.');
  if(r.imported&&day===invoiceDay)throw Error('Remboursement enregistré ailleurs : rapprochement des encaissements nécessaire avant journal ou clôture de cette journée.');
  if(day===invoiceDay&&day===refundDay&&!r.imported)result.push({revisionId:r.revisionId,saleId:sale.id,clientId:sale.clientId,clientName:current.clientName,recordedAt:r.createdAt,refund:r.refund});
 }
 return result;
}
