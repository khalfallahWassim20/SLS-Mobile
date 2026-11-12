/** Vue locale v5 préparatoire : ne pas afficher avec les soldes v3 actifs. */
import type {JournalExport} from './journal-export';
import {journalCsv} from './journal-export';
import {tunisDay} from './journal';
const safe=(n:bigint)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw Error('Total du journal trop élevé.');return Number(n);};
/** Le jeu de données doit provenir de readCreditJournalExportPrototype dans
 * une transaction ; les validations de l'export sont réutilisées ici pour
 * empêcher une facture incohérente d'être affichée comme annulée. */
export function describeCreditJournalPrototype(data:JournalExport) {
 journalCsv(data);
 if(!data.credits)throw Error('Avoirs locaux indisponibles.');
 const marks=new Map<string,{day:string;origin:'local'|'remote';pending:boolean}>();
 for(const {note,pending} of data.credits)marks.set(`${note.kind}:${note.command.invoiceId}`,{day:tunisDay(new Date(note.command.recordedAt)),origin:'local',pending});
 for(const remote of data.remoteCancellations??[])marks.set(`${remote.kind}:${remote.invoiceId}`,{day:remote.day,origin:'remote',pending:false});
 const updates=new Map((data.remoteSaleUpdates??[]).map(u=>[u.saleId,u.day]));
 const rows=data.rows.map(row=>({clientId:row.clientId,clientName:row.clientName,sector:row.sector,grossTotal:row.total,
  preInvoice:row.preInvoice?{...row.preInvoice,cancellation:marks.get(`preinvoice:${row.preInvoice.id}`)??null}:null,
  sales:row.sales.map(s=>({...s,cancellation:s.syncSaleId?marks.get(`sale:${s.syncSaleId}`)??null:null,remoteUpdateDay:s.syncSaleId?updates.get(s.syncSaleId)??null:null}))}));
 const events=data.credits.filter(x=>tunisDay(new Date(x.note.command.recordedAt))===data.day).map(({note,pending})=>{
  const source=note.source as Record<string,any>,invoice=note.kind==='sale'?source:source.invoice;
  return {operationId:note.command.operationId,kind:note.kind,invoiceId:note.command.invoiceId,clientName:invoice.clientName,invoiceTotal:note.kind==='sale'?invoice.total:invoice.amount,refund:note.refund,retainedCredit:note.retainedCredit,pending};
 });
 const receipts=data.receipts.filter(r=>r.journalDate===data.day&&rows.some(row=>row.clientId===r.clientId));
 const billed=rows.reduce((a,row)=>a+BigInt(row.grossTotal),0n),prePaid=receipts.reduce((a,r)=>a+BigInt(r.prePaid),0n),oldDebtPaid=receipts.reduce((a,r)=>a+BigInt(r.oldDebtPaid),0n),salePaid=rows.reduce((a,row)=>a+row.sales.reduce((n,s)=>n+BigInt(s.paid),0n),0n),credits=events.reduce((a,e)=>a+BigInt(e.invoiceTotal),0n),refunds=events.reduce((a,e)=>a+BigInt(e.refund),0n),retained=events.reduce((a,e)=>a+BigInt(e.retainedCredit),0n);
 const saleRefunds=data.saleRefunds??[],saleRefundTotal=safe(saleRefunds.reduce((n,r)=>n+BigInt(r.refund),0n));
 return {day:data.day,commercial:data.commercial,rows,events,saleRefunds,saleRefundTotal,hasRemoteCancellations:(data.remoteCancellations?.length??0)>0,
  totals:{billedGross:safe(billed),prePaid:safe(prePaid),oldDebtPaid:safe(oldDebtPaid),collectedGross:safe(prePaid+oldDebtPaid+salePaid),creditNotes:safe(credits),refunds:safe(refunds),retainedCredit:safe(retained),billedAfterLocalCredits:safe(billed-credits),collectedAfterLocalRefunds:safe(prePaid+oldDebtPaid+salePaid-refunds)}};
}
