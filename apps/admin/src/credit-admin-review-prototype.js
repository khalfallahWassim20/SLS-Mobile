/** Validation du parcours d'essai v5, non relié à l'interface active. */
import {canonicalJson,calculateFullCancellation,calculatePreInvoiceCancellation,summarizePreInvoice} from '@sls/domain';
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const day=x=>{const d=new Date(x);if(!Number.isFinite(d.getTime()))throw Error('Date de facture invalide.');const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);return ['year','month','day'].map(k=>p.find(v=>v.type===k)?.value).join('-');};
export function validateAdminCreditSources(value,clientId){
 if(!value||value.version!==5||value.clientId!==clientId||typeof value.active!=='boolean'||value.truncated!==false||!Array.isArray(value.items)||value.items.length>200)throw Error('Factures indisponibles ou trop nombreuses : sélection plus précise nécessaire.');
 const seen=new Set();return value.items.map(item=>{
  const source=item?.source,key=`${item?.kind}:${item?.invoiceId}`;
  if(!item||!['sale','preinvoice'].includes(item.kind)||!uuid(item.invoiceId)||!Number.isSafeInteger(item.version)||item.version<1||item.version>=1000000||! /^(?:[0-9a-f]{64})$/.test(item.hash)||!source||typeof source!=='object'||Array.isArray(source)||seen.has(key))throw Error('Facture invalide.');
  seen.add(key);let date,total,paid,oldDebtPaid;
  if(item.kind==='sale'){
   if(source.syncSaleId!==item.invoiceId||source.syncVersion!==item.version||source.clientId!==clientId||!Number.isSafeInteger(source.total)||source.total<0||!Number.isSafeInteger(source.paid)||source.paid<0)throw Error('Vente incohérente.');
   date=day(source.createdAt);total=source.total;paid=source.paid;oldDebtPaid=0;
  }else{
   const invoice=source.invoice;if(source.version!==item.version||invoice?.id!==item.invoiceId||invoice.clientId!==clientId||!Array.isArray(source.receipts))throw Error('Préétablie incohérente.');
   date=invoice.journalDate;const parsed=new Date(`${date}T00:00:00.000Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)throw Error('Date de facture invalide.');
   const sum=summarizePreInvoice(invoice.amount,source.receipts);total=invoice.amount;paid=sum.prePaid;oldDebtPaid=sum.oldDebtPaid;
  }
  return {...item,date,total,paid,oldDebtPaid};
 });
}
export function validateAdminCreditReview(review,clientId,item,command){
 if(!review||review.version!==5||review.clientId!==clientId||review.kind!==item.kind||review.sourceHash!==item.hash||canonicalJson(review.command)!==canonicalJson(command)||typeof review.clientName!=='string'||!review.clientName.trim()||review.invoiceDay!==item.date||review.invoiceTotal!==item.total||review.invoicePaid!==item.paid||review.oldDebtPaid!==item.oldDebtPaid||!Number.isSafeInteger(review.balanceBefore))throw Error('Aperçu incohérent : vérifiez à nouveau.');
 const result=item.kind==='sale'?calculateFullCancellation({balance:review.balanceBefore,invoiceTotal:item.total,invoiceNetPaid:item.paid,alreadyCancelled:false,choice:command.choice??undefined}):calculatePreInvoiceCancellation({balance:review.balanceBefore,invoiceTotal:item.total,receipts:item.source.receipts,alreadyCancelled:false,choice:command.choice??undefined});
 if(result.balanceAfter!==review.balanceAfter||result.refund!==review.refund||result.retainedCredit!==review.retainedCredit)throw Error('Montants de l’aperçu incohérents.');
 return review;
}
