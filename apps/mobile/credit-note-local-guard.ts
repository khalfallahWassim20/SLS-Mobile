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
