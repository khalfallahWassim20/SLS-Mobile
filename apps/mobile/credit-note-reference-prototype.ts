/** Contrat futur non utilisé par l'application. Une référence v5 ne doit pas
 * être réduite en v3/v4 : les anciens téléphones ignoreraient les avoirs. */
import {canonicalJson,prepareFullCreditNote,reconcilePreInvoiceCredits,type CreditNoteEvent,type CreditJournalState} from '@sls/domain';
import {validateIdentifiedReference} from './identified-reference';
const obj=(v:unknown):Record<string,unknown>|null=>typeof v==='object'&&v!==null&&!Array.isArray(v)?v as Record<string,unknown>:null;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export function validatePrototypeCreditReference(value:unknown) {
 const raw=obj(value);
 if(!raw||raw.experimental!==true||raw.version!==5||!Array.isArray(raw.saleStates)||!Array.isArray(raw.journalStates))throw Error('Référence d’avoirs invalide.');
 // Réutilise les validations du référentiel, des soldes, des reçus et preuves.
 const base=validateIdentifiedReference({...raw,version:4});
 const seen=new Set<string>(),settlements=new Set(base.settlementStates?.map(s=>s.operationId)??[]);
 const sales=(base.saleStates??[]).map((sale,index)=>{
  const input=obj((raw.saleStates as unknown[])[index]);
  if(!input||input.saleId!==sale.saleId||typeof input.cancelled!=='boolean')throw Error('État d’avoir de vente invalide.');
  if(input.cancelled===false){if(input.creditNote!==null)throw Error('Avoir de vente inattendu.');return {...sale,cancelled:false as const,creditNote:null};}
  const note=obj(input.creditNote);
  if(!note)throw Error('Avoir de vente manquant.');
  const event=note as unknown as CreditNoteEvent;
  if(!event.command||!event.source||!event.actor||!uuid(event.command.operationId)||event.command.invoiceId!==sale.saleId||event.resultVersion!==sale.version||sale.total!=='0'||String(event.retainedCredit)!==sale.paid||event.source.invoiceId!==sale.saleId||event.source.cancelled!==false)throw Error('Avoir de vente incohérent.');
  const calculated=prepareFullCreditNote({actor:event.actor,command:event.command,source:event.source,daysOpen:true,previous:null}).event;
  if(canonicalJson(event)!==canonicalJson(calculated)||seen.has(event.command.operationId)||settlements.has(event.command.operationId))throw Error('Avoir de vente incohérent ou dupliqué.');
  seen.add(event.command.operationId);return {...sale,cancelled:true as const,creditNote:calculated};
 });
 if(!Array.isArray(raw.saleProofs))throw Error('Preuves de vente absentes.');
 const cancelledSales=new Map(sales.filter(s=>s.creditNote).map(s=>[s.saleId,s]));
 const proofIds=new Set<string>();
 const saleProofs=raw.saleProofs.map(value=>{
  const p=obj(value),sale=p&&typeof p.saleId==='string'?cancelledSales.get(p.saleId):undefined;
  if(!p||!sale||proofIds.has(sale.saleId)||p.version!==sale.creditNote?.command.expectedVersion||typeof p.hash!=='string'||!/^[0-9a-f]{64}$/.test(p.hash)||Object.keys(p).length!==3)throw Error('Preuve de vente invalide.');
  proofIds.add(sale.saleId);return {saleId:sale.saleId,version:p.version as number,hash:p.hash};
 });
 if(saleProofs.length!==cancelledSales.size)throw Error('Preuves de vente incomplètes.');
 const proofs=new Map(base.journalProofs.map(p=>[p.id,p]));
 const journals=(base.journalStates??[]).map((state,index)=>{
  const input=obj((raw.journalStates as unknown[])[index]),proof=proofs.get(state.id);
  if(!input||input.id!==state.id||!proof||input.version!==proof.version||!Object.prototype.hasOwnProperty.call(input,'creditNote'))throw Error('Version de préétablie invalide.');
  const marker=input.creditNote;
  const m=marker===null?null:obj(marker),a=m?obj(m.actor):null;
  if(marker!==null&&(!m||!a))throw Error('Avoir de préétablie invalide.');
  const clean=m&&a?{operationId:m.operationId,expectedVersion:m.expectedVersion,choice:m.choice,recordedAt:m.recordedAt,actor:{id:a.id,role:a.role}}:null;
  if(canonicalJson(marker)!==canonicalJson(clean))throw Error('Avoir de préétablie incohérent.');
  const result:CreditJournalState={id:state.id,version:proof.version,total:state.total,receipts:state.receipts,creditNote:clean as CreditJournalState['creditNote']};
  // Valide intégralement le choix, l'acteur, les montants et les reçus.
  reconcilePreInvoiceCredits(0,[],[result]);
  if(result.creditNote){const id=result.creditNote.operationId;if(seen.has(id)||settlements.has(id))throw Error('Avoir dupliqué.');seen.add(id);}
  return {...state,version:result.version,creditNote:result.creditNote};
 });
 // Vérifie aussi les identifiants de reçus et d'avoirs entre préétablies.
 reconcilePreInvoiceCredits(0,[],journals);
 return {...base,version:5 as const,experimental:true as const,saleStates:sales,saleProofs,journalStates:journals};
}
