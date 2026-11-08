/** Projection indépendante pour essais, non branchée sur les soldes de l'API.
 * Les états de vente, avoirs et mouvements doivent provenir du MÊME instantané
 * de base de données. En cas d'incohérence, aucun solde n'est retourné. */
import {prepareFullCreditNote,canonicalJson,type CreditNoteEvent} from '@sls/domain';
type Sale={invoiceId:string;clientId:string;version:number;total:number;netPaid:number};
type Movement={operationId:string;kind:'invoice_cancellation'|'refund';balanceDelta:number};
type Balance={clientId:string;balance:number};
function number(n:bigint):number {
 if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(Number.MIN_SAFE_INTEGER))throw new RangeError('Solde trop élevé.');
 return Number(n);
}
/** Les soldes d'entrée incluent déjà la dernière version de chaque vente.
 * La valeur retournée inclut chaque mouvement d'avoir exactement une fois. */
export function projectPrototypeCreditNotes(balances:Balance[],sales:Sale[],events:CreditNoteEvent[],movements:Movement[]):Balance[] {
 const totals=new Map<string,bigint>();
 for(const b of balances) {
  if(!b.clientId||totals.has(b.clientId)||!Number.isSafeInteger(b.balance))throw new RangeError('Solde client incohérent.');
  totals.set(b.clientId,BigInt(b.balance));
 }
 const bySale=new Map<string,Sale>();
 for(const s of sales) {
  if(!s.invoiceId||!s.clientId||bySale.has(s.invoiceId)||!totals.has(s.clientId)||!Number.isSafeInteger(s.version)||s.version<1||!Number.isSafeInteger(s.total)||s.total<0||!Number.isSafeInteger(s.netPaid)||s.netPaid<0)throw new RangeError('Vente incohérente.');
  bySale.set(s.invoiceId,s);
 }
 const byOperation=new Map<string,CreditNoteEvent>(),usedSales=new Set<string>();
 for(const event of events) {
  const cmd=event?.command,sale=cmd&&bySale.get(cmd.invoiceId);
  if(!cmd||!sale||byOperation.has(cmd.operationId)||usedSales.has(cmd.invoiceId) || sale.version!==cmd.expectedVersion || event.source.invoiceId!==sale.invoiceId || event.source.version!==sale.version || event.source.total!==sale.total || event.source.netPaid!==sale.netPaid || event.source.cancelled!==false)throw new RangeError('Avoir ou version de vente incohérent.');
  const computed=prepareFullCreditNote({actor:event.actor,command:cmd,source:event.source,daysOpen:true,previous:null}).event;
  if(canonicalJson(computed)!==canonicalJson(event))throw new RangeError('Montants ou historique de l’avoir incohérents.');
  byOperation.set(cmd.operationId,event);usedSales.add(cmd.invoiceId);
 }
 const seen=new Set<string>();
 for(const m of movements) {
  const event=byOperation.get(m.operationId),key=`${m.operationId}:${m.kind}`;
  if(!event || seen.has(key) || !Number.isSafeInteger(m.balanceDelta) || (m.kind!=='invoice_cancellation'&&m.kind!=='refund'))throw new RangeError('Mouvement d’avoir incohérent.');
  if((m.kind==='invoice_cancellation'&&m.balanceDelta!==-event.noteTotal) || (m.kind==='refund'&&(event.refund===0 || m.balanceDelta!==event.refund)))throw new RangeError('Montant du mouvement incohérent.');
  seen.add(key);
 }
 for(const [id,event] of byOperation) {
  if(!seen.has(`${id}:invoice_cancellation`) || (event.refund>0&&!seen.has(`${id}:refund`)))throw new RangeError('Mouvement d’avoir manquant.');
  const sale=bySale.get(event.command.invoiceId)!;
  totals.set(sale.clientId,totals.get(sale.clientId)!+BigInt(event.balanceDelta));
 }
 return balances.map(b=>({clientId:b.clientId,balance:number(totals.get(b.clientId)!)}));
}
