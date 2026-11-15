/** Prépare une tentative stable pour l'écran expérimental. Elle reste en mémoire
 * seulement : ne pas monter cet écran avant d'avoir prévu la reprise durable. */
import type {captureNewDayInvoiceSale} from './day-invoice-sale-create';
import {tunisDay} from './journal';
export type NewSalePreview=Awaited<ReturnType<typeof captureNewDayInvoiceSale>>;
export type NewSaleAttempt={clientId:string;day:string;lines:NewSalePreview['lines'];fingerprint:string;saleId:string;operationId:string;createdAt:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function makeNewSaleAttempt(preview:NewSalePreview,now:Date,newId:()=>string):NewSaleAttempt{
 if(!preview||!uuid.test(preview.clientId)||typeof preview.fingerprint!=='string'||!preview.fingerprint||!Array.isArray(preview.lines)||!preview.lines.length||!(now instanceof Date)||!Number.isFinite(now.getTime())||tunisDay(now)!==preview.day)throw Error('La journée a changé ou l’aperçu est invalide : vérifiez à nouveau.');
 const saleId=newId(),operationId=newId();if(!uuid.test(saleId)||!uuid.test(operationId)||saleId.toLowerCase()===operationId.toLowerCase())throw Error('Identifiants de vente invalides.');
 return {clientId:preview.clientId,day:preview.day,lines:preview.lines.map(line=>({...line})),fingerprint:preview.fingerprint,saleId,operationId,createdAt:now.toISOString()};
}
