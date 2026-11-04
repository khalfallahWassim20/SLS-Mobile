/** Protocole serveur en préparation, pas encore exposé par HTTP.
 * Les soldes et marqueurs mobiles ne doivent pas être modifiés avant intégration complète. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validatePreInvoiceReceipt } from '@sls/domain';

const uuid = z.string().uuid();
const amount = z.number().int().safe().nonnegative();
export const journalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === value;
}, 'Date de tournée invalide');
const invoiceSchema = z.object({
  id:uuid, journalDate:journalDateSchema, clientId:uuid, clientName:z.string().trim().min(1).max(200),
  sector:z.string().max(100), amount:amount.positive(), createdAt:z.string().datetime()
}).strict();
const receiptSchema = z.object({
  id:uuid, preInvoiceId:uuid, clientId:uuid, journalDate:journalDateSchema, createdAt:z.string().datetime(),
  prePaid:amount, oldDebtPaid:amount, creditFull:z.boolean(), mode:z.enum(['Espèces','Chèque','Virement']),
  chequeNumber:z.string().max(100), chequeBank:z.string().max(100), chequeDue:z.string().max(100), oldDebtLimitAtStart:amount
}).strict();
const snapshotSchema = z.object({ operationId:uuid, version:z.number().int().min(1).max(1000000), invoice:invoiceSchema, receipts:z.array(receiptSchema).max(1000) }).strict();
export type JournalSnapshot = z.infer<typeof snapshotSchema>;

/** Valide chaque opération et retourne une représentation canonique destinée au hachage.
 * oldDebtLimitAtStart est une limite locale, pas une garantie du solde global hors ligne. */
export function parseJournalSnapshot(input: unknown): JournalSnapshot {
  const value = snapshotSchema.parse(input), ids = new Set<string>();
  let priorOldPaid = 0;
  for (let i=0; i<value.receipts.length; i++) {
    const r = value.receipts[i];
    if (ids.has(r.id)) throw new RangeError('Identifiant de règlement dupliqué.');
    ids.add(r.id);
    if (r.preInvoiceId !== value.invoice.id || r.clientId !== value.invoice.clientId || r.journalDate !== value.invoice.journalDate) throw new RangeError('Règlement rattaché à une autre facture.');
    if (r.oldDebtLimitAtStart !== value.receipts[0].oldDebtLimitAtStart) throw new RangeError('Ancienne dette initiale incohérente.');
    if (r.mode === 'Chèque' && (r.prePaid || r.oldDebtPaid) && (!r.chequeNumber.trim() || !r.chequeBank.trim() || !r.chequeDue.trim())) throw new RangeError('Informations du chèque incomplètes.');
    validatePreInvoiceReceipt(value.invoice.amount, value.receipts.slice(0,i), r, Math.max(0, r.oldDebtLimitAtStart - priorOldPaid));
    priorOldPaid += r.oldDebtPaid;
    if (!Number.isSafeInteger(priorOldPaid)) throw new RangeError('Règlement trop élevé.');
  }
  return value;
}
export function journalSnapshotHash(snapshot: JournalSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
/** À appeler sous verrou transactionnel, après recherche par operationId.
 * Le serveur garde toutes les versions. Une nouvelle version ajoute exactement une opération. */
export function validateJournalTransition(previous: JournalSnapshot | null, current: JournalSnapshot): void {
  if (!previous) {
    if (current.version !== 1) throw new RangeError('Première version du journal manquante.');
    // La première version peut reprendre les opérations déjà présentes sur un téléphone existant.
    return;
  }
  if (current.operationId === previous.operationId || current.version !== previous.version + 1) throw new RangeError('Version du journal incohérente.');
  if (JSON.stringify(previous.invoice) !== JSON.stringify(current.invoice)) throw new RangeError('Facture préétablie modifiée : correction non prise en charge.');
  if (current.receipts.length !== previous.receipts.length + 1 || previous.receipts.some((r,i) => JSON.stringify(r) !== JSON.stringify(current.receipts[i]))) throw new RangeError('Historique des règlements modifié ou incomplet.');
}
