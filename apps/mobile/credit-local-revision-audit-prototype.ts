/** Vérification commune des révisions importées avant affichage ou export.
 * Cette vérification locale détecte les incohérences ; elle ne remplace pas
 * la relecture authentifiée de la chaîne serveur lors du rapprochement. */
import {canonicalJson} from '@sls/domain';
import type {SavedSale} from './storage';

type Audit={operationId:string;saleId:string;actor:string;event:unknown;createdAt:string;previous:SavedSale;current:SavedSale;refund:number};
const uuid=(x:unknown)=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
export function assertImportedSaleRevision(a:Audit,localId:number,saleId:string,clientId:string):void {
 const event=a.event&&typeof a.event==='object'&&!Array.isArray(a.event)?a.event as Record<string,unknown>:null;
 const {id:_id,...source}=a.current;
 if(!event||Object.keys(event).sort().join(',')!=='operationId,recordedAt,refund,sale,saleId,version'||!uuid(a.operationId)||!uuid(a.actor)||a.saleId!==saleId||event.operationId!==a.operationId||event.saleId!==saleId||event.version!==a.current.syncVersion||event.recordedAt!==a.createdAt||event.refund!==a.refund||a.refund!==0||a.previous.id!==localId||a.current.id!==localId||a.previous.syncSaleId!==saleId||a.current.syncSaleId!==saleId||a.previous.clientId!==clientId||a.current.clientId!==clientId||!Number.isSafeInteger(a.previous.syncVersion)||!Number.isSafeInteger(a.current.syncVersion)||a.previous.syncVersion!+1!==a.current.syncVersion||a.previous.paid!==a.current.paid||canonicalJson(event.sale)!==canonicalJson(source)||!Number.isFinite(Date.parse(a.createdAt)))throw Error('Historique distant incohérent.');
}
