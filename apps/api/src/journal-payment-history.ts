/** Détail de chaque nouvelle opération identifiée reçue, sans répéter les anciens instantanés. */
import type {Pool} from 'pg';
import {z} from 'zod';
import {journalDateSchema,parseJournalSnapshot} from './journal-protocol.js';

export async function readJournalPaymentHistory(pool:Pool,commercialId:string,day:string) {
 z.string().uuid().parse(commercialId);journalDateSchema.parse(day);
 const db=await pool.connect();
 try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  if(!(await db.query('SELECT id FROM commercials WHERE id=$1 AND deleted_at IS NULL',[commercialId])).rows.length) throw new RangeError('Commercial introuvable.');
  // Les factures propres au commercial incluent tous leurs paiements identifiés.
  // Pour les anciennes factures sans propriétaire, seuls ses paiements sont attribuables.
  const result=await db.query(`SELECT e.operation_id AS "operationId",e.payload,e.received_at AS "receivedAt",
   e.commercial_id AS "commercialId",c.name AS "commercialName",i.commercial_id IS NULL AS inherited
   FROM identified_journal_events e JOIN identified_journal_invoices i ON i.id=e.invoice_id
   LEFT JOIN commercials c ON c.id=e.commercial_id
   WHERE i.journal_date=$2::date AND (i.commercial_id=$1 OR (i.commercial_id IS NULL AND e.commercial_id=$1))
   AND jsonb_array_length(e.payload->'receipts') > 0
   ORDER BY e.received_at DESC,e.operation_id DESC LIMIT 201`,[commercialId,day]);
  const entries=result.rows.slice(0,200).map(row=>{
   const snapshot=parseJournalSnapshot(row.payload),receipt=snapshot.receipts.at(-1);
   if(!receipt || snapshot.version===1)throw new RangeError('Historique de paiement identifié incohérent.');
   return {operationId:row.operationId,version:snapshot.version,invoiceId:snapshot.invoice.id,clientName:snapshot.invoice.clientName,
    commercialId:row.commercialId,commercialName:row.commercialName,inherited:row.inherited,receivedAt:new Date(row.receivedAt).toISOString(),
    createdAt:receipt.createdAt,prePaid:receipt.prePaid,oldDebtPaid:receipt.oldDebtPaid,creditFull:receipt.creditFull,
    mode:receipt.mode,chequeNumber:receipt.chequeNumber,chequeBank:receipt.chequeBank,chequeDue:receipt.chequeDue};
  });
  await db.query('COMMIT');return {day,commercialId,truncated:result.rows.length>200,entries};
 } catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
