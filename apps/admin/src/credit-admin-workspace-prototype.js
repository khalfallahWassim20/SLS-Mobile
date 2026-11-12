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

/** Lecture explicite, indicative et limitée aux événements déjà reçus. */
export async function loadSaleRefundDiagnostic(request,commercialId,day){
 if(!uuid(commercialId)||!validDay(day))throw Error('Commercial ou date invalide.');
 const value=await request(`identified-tour/${encodeURIComponent(commercialId)}/${encodeURIComponent(day)}/refund-diagnostic`,options());
 if(!value||value.version!==5||value.commercialId!==commercialId||value.day!==day||typeof value.truncated!=='boolean'||!Array.isArray(value.entries)||value.entries.length>200||!['open','closed'].includes(value.closure?.status)||!Number.isSafeInteger(value.closure.version)||value.closure.version<0)throw Error('Diagnostic de remboursement incohérent.');
 const preview=value.saleCashPreview;
 if(!preview||typeof preview.available!=='boolean')throw Error('Aperçu des flux de ventes indisponible.');
 if(!preview.available){if(typeof preview.reason!=='string'||!preview.reason.trim())throw Error('Aperçu des flux de ventes incohérent.');}
 else{
  if(!Array.isArray(preview.entries)||preview.entries.length>200||!Number.isSafeInteger(preview.received)||preview.received<0||!Number.isSafeInteger(preview.refund)||preview.refund<0||!Number.isSafeInteger(preview.net))throw Error('Aperçu des flux de ventes incohérent.');
  let received=0n,refund=0n;const saleIds=new Set();
  for(const p of preview.entries){
   if(!p||!uuid(p.saleId)||saleIds.has(p.saleId)||!uuid(p.clientId)||typeof p.clientName!=='string'||!p.clientName.trim()||!validDay(p.saleDay)||!Number.isSafeInteger(p.initialPaid)||p.initialPaid<0||!Number.isSafeInteger(p.receivedHere)||![0,p.initialPaid].includes(p.receivedHere)||(p.receivedHere>0&&p.saleDay!==day)||!Number.isSafeInteger(p.refundedHere)||p.refundedHere<0||p.refundedHere>p.initialPaid)throw Error('Flux de vente incohérent.');
   saleIds.add(p.saleId);received+=BigInt(p.receivedHere);refund+=BigInt(p.refundedHere);
  }
  if(received!==BigInt(preview.received)||refund!==BigInt(preview.refund)||received-refund!==BigInt(preview.net))throw Error('Totaux des flux de ventes incohérents.');
 }
 const seen=new Set();
 for(const e of value.entries){
  const actualDay=typeof e?.recordedAt==='string'&&Number.isFinite(Date.parse(e.recordedAt))?new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(e.recordedAt)):'';
  if(!e||!uuid(e.operationId)||seen.has(e.operationId)||!uuid(e.saleId)||!uuid(e.clientId)||!uuid(e.ownerId)||!uuid(e.actorId)||!validDay(e.saleDay)||(e.refundDay!==null&&!validDay(e.refundDay))||typeof e.clientName!=='string'||!e.clientName.trim()||typeof e.ownerName!=='string'||!e.ownerName.trim()||typeof e.actorName!=='string'||!e.actorName.trim()||!actualDay||(e.refundDay!==null&&actualDay!==e.refundDay)||!Number.isSafeInteger(e.version)||e.version<2||!Number.isSafeInteger(e.previousPaid)||!Number.isSafeInteger(e.currentPaid)||!Number.isSafeInteger(e.refund)||e.refund<=0||e.currentPaid<0||e.previousPaid-e.currentPaid!==e.refund||!((e.ownerId===commercialId&&e.saleDay===day)||(e.actorId===commercialId&&(e.refundDay===day||e.refundDay===null))))throw Error('Mouvement de remboursement incohérent.');
  seen.add(e.operationId);
 }
 return value;
}
