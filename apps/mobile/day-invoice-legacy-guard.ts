/** Les anciens écrans ne calculent pas les règlements unifiés ou la référence
 * v6. Bloquer les lectures et écritures obsolètes sans effacer aucune donnée. */
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>};
export async function assertLegacyMobileDayInvoiceSafe(tx:Tx):Promise<void>{
 const tables=await tx.getFirstAsync<{payments:number;reference:number}>(`SELECT
  EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_payments') AS payments,
  EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_reference_cache') AS reference`);
 if(!tables||![0,1].includes(tables.payments)||![0,1].includes(tables.reference))throw Error('État de facture du jour indisponible.');
 if(tables.payments){const row=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM day_invoice_payments) AS n');if(!row||row.n)throw Error('Facture du jour présente : anciens écrans indisponibles avant mise à jour.');}
 if(tables.reference){const row=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM day_invoice_reference_cache) AS n');if(!row||row.n)throw Error('Référence facture du jour présente : anciens écrans indisponibles avant mise à jour.');}
 const debtTable=await tx.getFirstAsync<{n:number}>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_invoice_old_debt_local') AS n");
 if(!debtTable)throw Error('Registre ancienne dette indisponible.');
 if(debtTable.n){const debt=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM day_invoice_old_debt_local) AS n');if(!debt||debt.n)throw Error('Règlement v6 présent : anciens écrans indisponibles avant mise à jour.');}
}
