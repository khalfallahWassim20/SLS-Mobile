import {validateReference,type ReferenceData} from './reference';
/** Validation préparatoire séparée de la v3 active : pas de changement du cache actuel. */
export function validateIdentifiedReference(value:unknown):Omit<ReferenceData,'version'|'syncedAt'>&{version:4;journalProofs:{id:string;version:number;hash:string}[]} {
 if(typeof value!=='object'||value===null||Array.isArray(value)||(value as {version?:unknown}).version!==4)throw Error('Référence individuelle invalide.');
 const raw=value as Record<string,unknown>;
 const parsed=validateReference({...raw,version:3});
 if(parsed.version!==3||!parsed.journalStates || parsed.journalStates.some(x=>!x.journalDate))throw Error('Dates de journal individuelles manquantes.');
 if(!Array.isArray(raw.journalProofs)||raw.journalProofs.length!==parsed.journalStates.length)throw Error('Preuves du journal absentes.');
 const expected=new Set(parsed.journalStates.map(state=>state.id)),seen=new Set<string>();
 const journalProofs=raw.journalProofs.map(value=>{
  if(typeof value!=='object'||value===null||Array.isArray(value))throw Error('Preuve du journal invalide.');
  const p=value as Record<string,unknown>;
  if(typeof p.id!=='string'||!expected.has(p.id)||seen.has(p.id)||!Number.isSafeInteger(p.version)||(p.version as number)<1||(p.version as number)>1000000||typeof p.hash!=='string'||!/^[0-9a-f]{64}$/.test(p.hash))throw Error('Preuve du journal invalide.');
  seen.add(p.id);return {id:p.id,version:p.version as number,hash:p.hash};
 });
 return {...parsed,version:4,journalProofs};
}
/** Évite de remplacer un cache plus récent par une référence incomplète. */
export function assertNoReferenceDowngrade(current:number|null,next:number):void {
 if(!Number.isInteger(next)||next<1||next>4||current!==null&&(!Number.isInteger(current)||current<1||current>4||next<current))throw Error('Retour à une ancienne référence refusé.');
}
