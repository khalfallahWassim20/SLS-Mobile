import {readPrototypeCreditReferenceCache} from './credit-note-reference-cache-prototype';
import type {DeviceIdentity} from './identified-device';
/** À exécuter dans la transaction exclusive de modification/paiement.
 * La table est créée lors de l'ouverture normale de la base, même si aucun
 * écran ne permet encore de créer un avoir. */
type Tx={getFirstAsync<T>(sql:string,...params:(string|number|null)[]):Promise<T|null>};
export async function assertNoLocalCreditNote(tx:Tx,kind:'sale'|'preinvoice',invoiceId:string|undefined):Promise<void> {
 if(!invoiceId)return;
 const existing=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM offline_credit_prototype WHERE kind=? AND invoice_id=?) AS n',kind,invoiceId);
 if(!existing)throw Error('État local des avoirs indisponible.');
 if(existing.n)throw Error('Facture annulée : modification ou paiement refusé.');
}

/** Refuse aussi une annulation découverte sur un autre appareil. La présence
 * d'un cache invalide ne doit jamais être interprétée comme une facture active. */
export async function assertNoRemoteCreditNote(tx:Tx & {runAsync(sql:string,...params:(string|number|null)[]):Promise<unknown>},identity:DeviceIdentity|null,kind:'sale'|'preinvoice',invoiceId:string|undefined):Promise<void> {
 if(!identity||!invoiceId)return;
 const reference=await readPrototypeCreditReferenceCache(tx,identity);
 if(!reference)return;
 const cancelled=kind==='sale'?reference.saleStates.some(s=>s.saleId===invoiceId&&s.creditNote!==null):reference.journalStates.some(s=>s.id===invoiceId&&s.creditNote!==null);
 if(cancelled)throw Error('Facture annulée sur le serveur : modification ou paiement refusé.');
}

/** Garde préparatoire pour les NOUVELLES ventes/préétablies v5 : une fiche
 * inactive reste dans le cache pour rapprocher son historique, mais ne doit
 * pas être proposée comme client actif. Les écritures déjà enregistrées hors
 * ligne et les annulations nécessitent un traitement distinct. */
export async function assertPrototypeClientActive(tx:Tx & {runAsync(sql:string,...params:(string|number|null)[]):Promise<unknown>},identity:DeviceIdentity,clientId:string):Promise<void> {
 const reference=await readPrototypeCreditReferenceCache(tx,identity);
 const client=reference?.clients.find(c=>c.id===clientId);
 if(!client)throw Error('Client inconnu : actualisez les données avant une nouvelle opération.');
 if(!client.active)throw Error('Client désactivé : nouvelle vente ou facture refusée.');
}
