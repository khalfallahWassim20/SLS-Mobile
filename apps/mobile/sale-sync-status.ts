/** Présentation prudente : l'absence de file ne prouve pas à elle seule que le
 * serveur a reçu la vente. La référence peut être antérieure à l'envoi. */
type Sale={syncSaleId?:string;syncVersion?:number;clientId:string;total:number;paid:number};
type Marker={saleId:string;clientId:string;version:number;total:string;paid:string};
export function saleSyncStatus(sale:Sale,outbox:readonly {saleId:string}[],reference:{saleStates?:readonly Marker[]}|null,unavailable:boolean):string {
 if(unavailable)return 'État de synchronisation indisponible';
 if(!sale.syncSaleId)return 'Vente locale seulement';
 if(outbox.some(entry=>entry.saleId===sale.syncSaleId))return 'En attente d’envoi ou d’accusé';
 if(!reference?.saleStates)return 'État serveur à vérifier';
 const matches=reference.saleStates.filter(state=>state.saleId===sale.syncSaleId);
 if(matches.length!==1)return 'État serveur à vérifier';
 const remote=matches[0];
 if(remote.clientId!==sale.clientId||!Number.isSafeInteger(sale.syncVersion)||!Number.isSafeInteger(sale.total)||!Number.isSafeInteger(sale.paid))return 'État serveur incohérent à vérifier';
 if(remote.version<sale.syncVersion!)return 'Dernière version locale non confirmée par le téléchargement';
 if(remote.version!==sale.syncVersion||remote.total!==String(sale.total)||remote.paid!==String(sale.paid))return 'État serveur incohérent à vérifier';
 return 'Version et montants présents au dernier téléchargement';
}
