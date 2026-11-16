/** Verrou en mémoire du contrôleur v6 : le registre SQLite reste la preuve
 * durable, ce verrou évite de créer une intention pendant un transfert actif. */
let busy=false;
export function acquireDayInvoiceSync(){if(busy)throw Error('Synchronisation de facture du jour déjà en cours.');busy=true;}
export function releaseDayInvoiceSync(){busy=false;}
export function assertDayInvoiceSyncIdle(){if(busy)throw Error('Synchronisation en cours : attendez avant de préparer une opération.');}
