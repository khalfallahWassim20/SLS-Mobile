/** Audit en LECTURE SEULE des avoirs enregistrés. Ne modifie rien.
 * Usage : npm run audit:avoirs  (ajouter « -- <idCommercial> <AAAA-MM-JJ> » pour vérifier aussi les totaux du journal de ce jour). Code de sortie 0 = aucune anomalie, 2 = anomalies.
 * Couvre les avoirs de vente et de factures préétablies ; pas la caisse physique. */
import dotenv from 'dotenv';
dotenv.config({path:'apps/api/.env'});
import pg from 'pg';
import {auditCreditJournal,type CreditJournalView} from '@sls/domain';
import {readPrototypeCreditJournal} from './credit-note-journal-prototype.js';
import {auditStoredCreditNotes,auditStoredPreInvoiceCreditNotes} from './credit-note-audit-read.js';
if(!process.env.DATABASE_URL){console.error('DATABASE_URL manquante dans apps/api/.env.');process.exit(1);}
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL}),db=await pool.connect();
let code=0;
try{
 await db.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ');
 const sales=await auditStoredCreditNotes(db),pre=await auditStoredPreInvoiceCreditNotes(db);
 await db.query('COMMIT');
 for(const [label,result] of [['vente',sales],['préétablie',pre]] as const){
  console.log(`Avoirs de ${label} vérifiés : ${result.checked}. Anomalies : ${result.issues.length}.`);
  for(const i of result.issues)console.log(`- [${i.code}] opération ${i.operationId??'?'} facture ${i.invoiceId??'?'} : ${i.detail}`);
  if(result.issues.length>0)code=2;
 }
 const [commercialId,day]=process.argv.slice(2);
 if(commercialId||day){
  if(!commercialId||!day||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)){console.error('Usage : npm run audit:avoirs -- <idCommercial> <AAAA-MM-JJ>');code=1;}
  else{
   const journal=await readPrototypeCreditJournal(pool,commercialId,day),issues=auditCreditJournal(journal as unknown as CreditJournalView);
   console.log(`Journal du ${day} : ${issues.length} anomalie(s). Avoirs du jour : ${journal.creditEvents.length}, remboursé en caisse : ${journal.creditRefundTotal}, crédit conservé : ${journal.creditRetainedTotal}, encaissé après remboursements : ${journal.collectedAfterRefunds}.`);
   for(const i of issues)console.log(`- [${i.code}] ${i.detail}`);
   if(issues.length>0)code=2;
  }
 }
}catch(e){console.error('Audit impossible :',e instanceof Error?e.message:e);code=1;}
finally{db.release();await pool.end();}
process.exit(code);
