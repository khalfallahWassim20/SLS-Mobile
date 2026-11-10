/** Adaptateur de l'espace admin v5 isolé. Ne pas monter tant que la migration
 * des téléphones et des routes actives n'est pas terminée. Aucune route v3
 * n'est utilisée en secours si une réponse v5 manque ou est incohérente. */
import {canonicalJson} from '@sls/domain';
import {adaptCreditAdminSnapshot} from './credit-snapshot-prototype.js';
import {creditDetails,journalServerCsv,journalServerHtml} from './journal-export.js';
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const validDay=x=>{if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x))return false;const d=new Date(x+'T00:00:00.000Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===x;};
const options=()=>({headers:{'X-SLS-Reference-Version':'5'}});
export async function loadCreditAdminSnapshot(request){
 return adaptCreditAdminSnapshot(await request('identified-tour/credit-snapshot',options()));
}
/** L'historique doit correspondre à la même facture que l'instantané montré.
 * Un changement concurrent impose de recharger plutôt que de mélanger les vues. */
export async function loadCreditAdminSaleHistory(request,sale){
 if(!sale||!uuid(sale.saleId)||sale.creditVersion!==5)throw Error('Vente v5 invalide.');
 const value=await request(`identified-tour/credit-sales/${encodeURIComponent(sale.saleId)}/history`,options());
 if(!value||value.version!==5||value.saleId!==sale.saleId||typeof value.truncated!=='boolean'||typeof value.cancelled!=='boolean'||!Array.isArray(value.versions)||!value.versions.length||value.versions.length>200||value.cancelled!==sale.cancelled||canonicalJson(value.creditNote)!==canonicalJson(sale.creditNote))throw Error('Historique modifié : actualisez les ventes.');
 const seen=new Set();let previous=Infinity;
 for(const entry of value.versions){
  if(!entry||!uuid(entry.operationId)||seen.has(entry.operationId)||!Number.isSafeInteger(entry.version)||entry.version<1||entry.version>=previous||!Number.isSafeInteger(entry.refund)||entry.refund<0||entry.sale?.syncSaleId!==sale.saleId||entry.sale?.syncVersion!==entry.version||entry.sale?.clientId!==sale.sale.clientId||!Array.isArray(entry.sale?.lines))throw Error('Historique de vente invalide.');
  seen.add(entry.operationId);previous=entry.version;
 }
 if(value.versions[0].version!==sale.version||canonicalJson(value.versions[0].sale)!==canonicalJson(sale.sale))throw Error('Historique modifié : actualisez les ventes.');
 return value;
}
export async function loadCreditAdminJournal(request,commercialId,day){
 if(!uuid(commercialId)||!validDay(day))throw Error('Commercial ou date invalide.');
 const value=await request(`identified-tour/${encodeURIComponent(commercialId)}/${encodeURIComponent(day)}`,options());
 if(!value||value.creditVersion!==5||value.commercial?.id!==commercialId||value.day!==day||!value.commercial.name||!['open','closed'].includes(value.closure?.status)||!Number.isSafeInteger(value.closure?.version)||value.closure.version<0)throw Error('Journal v5 incohérent.');
 if(!creditDetails(value))throw Error('Journal v5 indisponible.');
 // Les mêmes validations et conversions sont utilisées pour l'écran et export.
 journalServerCsv(value,new Date(0).toISOString());
 return value;
}
export async function exportCreditAdminJournal(request,commercialId,day,format,now=()=>new Date()){
 if(format!=='csv'&&format!=='pdf')throw Error('Format invalide.');
 const journal=await loadCreditAdminJournal(request,commercialId,day),generatedAt=now().toISOString();
 return {journal,content:format==='csv'?journalServerCsv(journal,generatedAt):journalServerHtml(journal,generatedAt),name:`journal-${day}-${commercialId}.${format==='csv'?'csv':'html'}`};
}
