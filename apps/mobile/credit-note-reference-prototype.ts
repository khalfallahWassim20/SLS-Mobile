/** Contrat futur non utilisé par l'application. Une référence v5 ne doit pas
 * être réduite en v3/v4 : les anciens téléphones ignoreraient les avoirs. */
import {canonicalJson,prepareFullCreditNote,reconcilePreInvoiceCredits,calculatePreInvoiceCancellation,type CreditNoteEvent,type CreditJournalState} from '@sls/domain';
import {validateIdentifiedReference} from './identified-reference';
const obj=(v:unknown):Record<string,unknown>|null=>typeof v==='object'&&v!==null&&!Array.isArray(v)?v as Record<string,unknown>:null;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export function validatePrototypeCreditReference(value:unknown) {
 const raw=obj(value);
 if(!raw||raw.experimental!==true||raw.version!==5||!Array.isArray(raw.saleStates)||!Array.isArray(raw.journalStates))throw Error('Référence d’avoirs invalide.');
 // Réutilise les validations du référentiel, des soldes, des reçus et preuves.
 const base=validateIdentifiedReference({...raw,version:4});
 if(!Array.isArray(raw.clients)||raw.clients.length!==base.clients.length)throw Error('Statuts clients absents.');
 const clients=base.clients.map((client,index)=>{
  const original=obj((raw.clients as unknown[])[index]);
  if(!original||original.id!==client.id||typeof original.active!=='boolean'||typeof original.statusRevision!=='string'||! /^[1-9]\d{0,18}$/.test(original.statusRevision)||BigInt(original.statusRevision)>9223372036854775807n)throw Error('Statut client invalide.');
  return {...client,active:original.active,statusRevision:original.statusRevision};
 });
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
 if(!Array.isArray(raw.eligibleSaleProofs)||!Array.isArray(raw.eligibleJournalIds))throw Error('Sources identifiées absentes.');
 const availableSales=new Map(sales.filter(s=>!s.creditNote).map(s=>[s.saleId,s])),availableJournals=new Set(journals.filter(j=>!j.creditNote).map(j=>j.id)),eligibleIds=new Set<string>();
 const eligibleSaleProofs=raw.eligibleSaleProofs.map(value=>{
  const proof=obj(value),sale=proof&&typeof proof.saleId==='string'?availableSales.get(proof.saleId):undefined;
  if(!proof||!sale||eligibleIds.has(sale.saleId)||proof.version!==sale.version||typeof proof.hash!=='string'||!/^[0-9a-f]{64}$/.test(proof.hash)||Object.keys(proof).length!==3)throw Error('Source de vente identifiée invalide.');
  eligibleIds.add(sale.saleId);return {saleId:sale.saleId,version:sale.version,hash:proof.hash};
 });
 const seenJournals=new Set<string>();
 const eligibleJournalIds=raw.eligibleJournalIds.map(id=>{if(typeof id!=='string'||!availableJournals.has(id)||seenJournals.has(id))throw Error('Source préétablie identifiée invalide.');seenJournals.add(id);return id;});
 // Ancien cache hors ligne sans cette liste : ne pas inventer d'affectations.
 // La liste fournie par le serveur est reliée aux avoirs et à leurs montants.
 let cashAssignments:null|{noteOperationId:string;requestId:string;commercialId:string|null;refund:number;actorId:string;assignedAt:string}[]=null;
 if(raw.cashAssignments!==undefined&&raw.cashAssignments!==null){
  if(!Array.isArray(raw.cashAssignments))throw Error('Attributions de caisse invalides.');
  const notes=new Map<string,{refund:number;actor:{id:string;role:string}}>();
  for(const s of sales)if(s.creditNote)notes.set(s.creditNote.command.operationId,{refund:s.creditNote.refund,actor:s.creditNote.actor});
  for(const j of journals)if(j.creditNote){const c=calculatePreInvoiceCancellation({balance:0,invoiceTotal:j.total,receipts:j.receipts,alreadyCancelled:false,choice:j.creditNote.choice??undefined});notes.set(j.creditNote.operationId,{refund:c.refund,actor:j.creditNote.actor});}
  const ids=new Set<string>(),requests=new Set<string>();
  cashAssignments=raw.cashAssignments.map(value=>{
   const a=obj(value),note=a&&typeof a.noteOperationId==='string'?notes.get(a.noteOperationId):undefined;
   if(!a||Object.keys(a).sort().join(',')!=='actorId,assignedAt,commercialId,noteOperationId,refund,requestId'||!uuid(a.noteOperationId)||!uuid(a.requestId)||(a.commercialId!==null&&!uuid(a.commercialId))||!note||note.actor.role!=='admin'||note.refund<=0||a.refund!==note.refund||typeof a.actorId!=='string'||!a.actorId.trim()||a.actorId.length>200||typeof a.assignedAt!=='string'||!Number.isFinite(Date.parse(a.assignedAt))||new Date(a.assignedAt).toISOString()!==a.assignedAt||ids.has(a.noteOperationId)||requests.has(a.requestId))throw Error('Attribution de caisse incohérente.');
   ids.add(a.noteOperationId);requests.add(a.requestId);return {noteOperationId:a.noteOperationId,requestId:a.requestId,commercialId:a.commercialId as string|null,refund:a.refund as number,actorId:a.actorId,assignedAt:a.assignedAt};
  });
 }
 // L'absence du champ correspond à un ancien cache : elle ne prouve aucun
 // propriétaire. La liste récente doit couvrir chaque avoir exactement une fois.
 let creditOwners:null|{operationId:string;ownerId:string|null}[]=null;
 if(raw.creditOwners!==undefined&&raw.creditOwners!==null){
  if(!Array.isArray(raw.creditOwners))throw Error('Propriétaires des avoirs invalides.');
  const ownersSeen=new Set<string>();
  creditOwners=raw.creditOwners.map(value=>{
   const item=obj(value);
   if(!item||Object.keys(item).sort().join(',')!=='operationId,ownerId'||!uuid(item.operationId)||!seen.has(item.operationId)||(item.ownerId!==null&&!uuid(item.ownerId))||ownersSeen.has(item.operationId))throw Error('Propriétaire d’avoir incohérent.');
   ownersSeen.add(item.operationId);return {operationId:item.operationId,ownerId:item.ownerId as string|null};
  });
  if(ownersSeen.size!==seen.size)throw Error('Propriétaires des avoirs incomplets.');
 }
 // Vérifie aussi les identifiants de reçus et d'avoirs entre préétablies.
 reconcilePreInvoiceCredits(0,[],journals);
 return {...base,version:5 as const,experimental:true as const,clients,saleStates:sales,saleProofs,eligibleSaleProofs,eligibleJournalIds,journalStates:journals,cashAssignments,creditOwners};
}

/** Seule cette liste est destinée au choix d'un client pour une nouvelle
 * opération. Le référentiel complet sert au rapprochement historique. */
export function activePrototypeClients(reference:ReturnType<typeof validatePrototypeCreditReference>) {
 return reference.clients.filter(client=>client.active);
}
