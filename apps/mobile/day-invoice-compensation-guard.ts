/** Barrière aussi conservée après synchronisation : le reçu ne rend pas les
 * anciennes vues capables de calculer les soldes ou la caisse. */
export async function assertNoLocalDayCompensation(tx:{getFirstAsync<T>(sql:string,...args:(string|number|null)[]):Promise<T|null>}){
 const exists=await tx.getFirstAsync<{n:number}>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_compensation_local') AS n");
 if(!exists||![0,1].includes(exists.n))throw Error('Registre de compensation indisponible.');
 if(exists.n){const row=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM day_invoice_compensation_local) AS n');if(!row||row.n)throw Error('Compensation de facture du jour : rapprochement requis avant utilisation des anciens calculs.');}
}
