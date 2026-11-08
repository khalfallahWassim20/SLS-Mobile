import {prepareFullCreditNote,type CreditNoteEvent} from './credit-note-command.ts';
import {canonicalJson} from './canonical-json.ts';

type LocalSale={syncSaleId?:string;syncVersion?:number;total:number;paid:number;creditNote:CreditNoteEvent|null};
type ServerSale={saleId:string;version:number;total:number;paid:number;creditNote:CreditNoteEvent|null};
type Settlement={syncOperationId?:string;amount:number};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
function money(value:number,min=0){if(!Number.isSafeInteger(value)||value<min)throw new RangeError('Montant invalide');}
function version(value:unknown):asserts value is number {if(!Number.isSafeInteger(value)||(value as number)<1||(value as number)>1000000)throw new RangeError('Version invalide');}
function noteValid(note:CreditNoteEvent,id:string) {
 if(!note?.command||note.command.invoiceId!==id||!note.source||!note.actor)throw new RangeError('Avoir de vente invalide');
 const computed=prepareFullCreditNote({actor:note.actor,command:note.command,source:note.source,daysOpen:true,previous:null}).event;
 if(canonicalJson(note)!==canonicalJson(computed))throw new RangeError('Avoir de vente incohérent');
}
/** Projet expérimental. Le solde serveur inclut déjà tous les avoirs serveur.
 * Les éléments locaux et distants doivent concerner le même client ; ne jamais
 * ignorer conflict=true. Les avoirs locaux gardent leur source inchangée. */
export function reconcileSaleCredits(input:{serverBalance:number;localSales:LocalSale[];serverSales:ServerSale[];localSettlements:Settlement[];serverSettlementIds:string[]}) {
 money(input.serverBalance,Number.MIN_SAFE_INTEGER);
 const remote=new Map<string,ServerSale>(),remoteNotes=new Map<string,string>();
 for(const s of input.serverSales){
  if(!uuid(s.saleId)||remote.has(s.saleId))throw new RangeError('Vente serveur invalide ou dupliquée');
  version(s.version);money(s.total);money(s.paid);
  if(s.creditNote!==null){
   noteValid(s.creditNote,s.saleId);
   if(s.version!==s.creditNote.resultVersion||s.total!==0||s.paid!==s.creditNote.retainedCredit||remoteNotes.has(s.creditNote.command.operationId))throw new RangeError('État d’avoir serveur incohérent');
   remoteNotes.set(s.creditNote.command.operationId,s.saleId);
  }
  remote.set(s.saleId,s);
 }
 let balance=BigInt(input.serverBalance),conflict=false;
 const localIds=new Set<string>(),localNotes=new Set<string>();
 for(const s of input.localSales) {
  money(s.total);money(s.paid);
  if(s.syncSaleId!==undefined){if(!uuid(s.syncSaleId)||localIds.has(s.syncSaleId))throw new RangeError('Vente locale invalide ou dupliquée');localIds.add(s.syncSaleId);version(s.syncVersion);}
  else if(s.syncVersion!==undefined||s.creditNote!==null)throw new RangeError('Vente locale sans identité');
  if(s.creditNote!==null){
   noteValid(s.creditNote,s.syncSaleId!);
   if(s.creditNote.source.version!==s.syncVersion||s.creditNote.source.total!==s.total||s.creditNote.source.netPaid!==s.paid||localNotes.has(s.creditNote.command.operationId))throw new RangeError('État d’avoir local incohérent');
   localNotes.add(s.creditNote.command.operationId);
   const owner=remoteNotes.get(s.creditNote.command.operationId);if(owner!==undefined&&owner!==s.syncSaleId)conflict=true;
  }
  const r=s.syncSaleId?remote.get(s.syncSaleId):undefined;
  if(!r){balance+=BigInt(s.total)-BigInt(s.paid)+BigInt(s.creditNote?.balanceDelta??0);continue;}
  if(r.creditNote!==null){
   if(!s.creditNote||canonicalJson(s.creditNote)!==canonicalJson(r.creditNote)){conflict=true;continue;}
   continue; // Le solde serveur contient déjà l'avoir exact.
  }
  if(s.syncVersion!<r.version||(s.syncVersion===r.version&&(s.total!==r.total||s.paid!==r.paid))){conflict=true;continue;}
  if(s.syncVersion!>r.version)balance+=BigInt(s.total)-BigInt(s.paid)-BigInt(r.total)+BigInt(r.paid);
  if(s.creditNote)balance+=BigInt(s.creditNote.balanceDelta);
 }
 const paidIds=new Set<string>();
 for(const id of input.serverSettlementIds){if(!uuid(id)||paidIds.has(id))throw new RangeError('Règlement serveur invalide ou dupliqué');paidIds.add(id);}
 const localPaid=new Set<string>();
 for(const p of input.localSettlements){
  money(p.amount,1);
  if(p.syncOperationId!==undefined){if(!uuid(p.syncOperationId)||localPaid.has(p.syncOperationId))throw new RangeError('Règlement local invalide ou dupliqué');localPaid.add(p.syncOperationId);}
  if(!p.syncOperationId||!paidIds.has(p.syncOperationId))balance-=BigInt(p.amount);
 }
 if(balance<BigInt(Number.MIN_SAFE_INTEGER)||balance>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Solde trop élevé');
 return {balance:Number(balance),conflict};
}
