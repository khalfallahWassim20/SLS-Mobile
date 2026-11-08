import {validateReference,type ReferenceData} from './reference';
/** Validation préparatoire séparée de la v3 active : pas de changement du cache actuel. */
export function validateIdentifiedReference(value:unknown):Omit<ReferenceData,'version'|'syncedAt'>&{version:4} {
 if(typeof value!=='object'||value===null||Array.isArray(value)||(value as {version?:unknown}).version!==4)throw Error('Référence individuelle invalide.');
 const raw=value as Record<string,unknown>;
 const parsed=validateReference({...raw,version:3});
 if(parsed.version!==3||!parsed.journalStates || parsed.journalStates.some(x=>!x.journalDate))throw Error('Dates de journal individuelles manquantes.');
 return {...parsed,version:4};
}
/** Évite de remplacer un cache plus récent par une référence incomplète. */
export function assertNoReferenceDowngrade(current:number|null,next:number):void {
 if(!Number.isInteger(next)||next<1||next>4||current!==null&&(!Number.isInteger(current)||current<1||current>4||next<current))throw Error('Retour à une ancienne référence refusé.');
}
