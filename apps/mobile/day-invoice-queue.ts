import {dayInvoiceOldDebtSchema} from './day-invoice-old-debt-queue';
/** Stockage transactionnel préparatoire, non relié à l'interface ni à la synchronisation.
 * L'appelant doit fournir une transaction exclusive et vérifier les gardes métier,
 * l'identité, la journée de la facture et celle de l'enregistrement sous ce verrou. */
import { validateDayPayment, type DayInvoicePayment } from '../../packages/domain/src/day-invoice';

type Bind = string | number | null;
type Tx = {
  getFirstAsync<T>(sql:string,...args:Bind[]):Promise<T|null>;
  getAllAsync<T>(sql:string,...args:Bind[]):Promise<T[]>;
  runAsync(sql:string,...args:Bind[]):Promise<unknown>;
};
export const dayInvoiceQueueSchema = `
CREATE TABLE IF NOT EXISTS day_invoice_payments (
 operation_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, invoice_day TEXT NOT NULL, payload TEXT NOT NULL,
 commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS day_invoice_payment_outbox (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
 commercial_id TEXT NOT NULL, server_origin TEXT NOT NULL,
 FOREIGN KEY(operation_id) REFERENCES day_invoice_payments(operation_id)
);
CREATE INDEX IF NOT EXISTS day_invoice_payments_by_client_day ON day_invoice_payments(client_id,invoice_day);
${dayInvoiceOldDebtSchema}`;
export type DayInvoiceQueueEntry = { sequence:number; operationId:string; payload:string; commercialId:string; serverOrigin:string };
export type DayInvoiceIdentity = { commercialId:string; serverOrigin:string };
function assertIdentity(identity:DayInvoiceIdentity):void {
 if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.commercialId)) throw Error("Identité commerciale invalide.");
 try {const u=new URL(identity.serverOrigin);if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.origin!==identity.serverOrigin)throw Error();} catch {throw Error("Adresse serveur invalide.");}
}
/** Toute exception de guard doit entraîner l'annulation de la transaction par l'appelant. */
export async function appendDayInvoicePayment(tx:Tx, payment:DayInvoicePayment, identity:DayInvoiceIdentity, guard:(tx:Tx,payment:DayInvoicePayment,identity:DayInvoiceIdentity)=>Promise<void>):Promise<'created'|'duplicate'> {
 validateDayPayment(payment);
 assertIdentity(identity);
 const payload=JSON.stringify(payment);
 await guard(tx,payment,identity);
 const existing=await tx.getFirstAsync<{payload:string;commercialId:string;serverOrigin:string}>(`SELECT payload,commercial_id AS commercialId,server_origin AS serverOrigin FROM day_invoice_payments WHERE operation_id=?`,payment.operationId);
 if(existing) {
  if(existing.payload!==payload || existing.commercialId!==identity.commercialId || existing.serverOrigin!==identity.serverOrigin) throw Error('Identifiant de paiement déjà utilisé avec d’autres données.');
  return 'duplicate';
 }
 await tx.runAsync('INSERT INTO day_invoice_payments(operation_id,client_id,invoice_day,payload,commercial_id,server_origin) VALUES(?,?,?,?,?,?)',payment.operationId,payment.clientId,payment.day,payload,identity.commercialId,identity.serverOrigin);
 await tx.runAsync('INSERT INTO day_invoice_payment_outbox(operation_id,payload,commercial_id,server_origin) VALUES(?,?,?,?)',payment.operationId,payload,identity.commercialId,identity.serverOrigin);
 return 'created';
}
/** Retire uniquement une entrée inchangée après vérification de l'accusé du serveur. */
export async function acknowledgeDayInvoicePayment(tx:Tx, entry:DayInvoiceQueueEntry):Promise<void> {
 const row=await tx.getFirstAsync<DayInvoiceQueueEntry & {originalPayload:string;originalCommercialId:string;originalServerOrigin:string;originalClientId:string;originalDay:string}>(`SELECT o.sequence,o.operation_id AS operationId,o.payload,o.commercial_id AS commercialId,o.server_origin AS serverOrigin,
 p.payload AS originalPayload,p.commercial_id AS originalCommercialId,p.server_origin AS originalServerOrigin,p.client_id AS originalClientId,p.invoice_day AS originalDay
 FROM day_invoice_payment_outbox o JOIN day_invoice_payments p ON p.operation_id=o.operation_id WHERE o.operation_id=?`,entry.operationId);
 if(!row || row.sequence!==entry.sequence || row.operationId!==entry.operationId || row.payload!==entry.payload || row.commercialId!==entry.commercialId || row.serverOrigin!==entry.serverOrigin || row.originalPayload!==row.payload || row.originalCommercialId!==row.commercialId || row.originalServerOrigin!==row.serverOrigin) throw Error('File modifiée : accusé refusé.');
 let payment:DayInvoicePayment;try{payment=JSON.parse(row.payload);validateDayPayment(payment);}catch{throw Error('File modifiée : accusé refusé.');}
 if(payment.operationId!==row.operationId||payment.clientId!==row.originalClientId||payment.day!==row.originalDay)throw Error('File modifiée : accusé refusé.');
 await tx.runAsync('DELETE FROM day_invoice_payment_outbox WHERE operation_id=?',entry.operationId);
}

/** Lecture exclusive : refuse les paiements locaux incomplets ou liés à un autre téléphone. */
export async function readDayInvoicePayments(tx:Tx,identity:DayInvoiceIdentity,clientId:string,day:string):Promise<DayInvoicePayment[]> {
 assertIdentity(identity);
 const rows=await tx.getAllAsync<{operationId:string;clientId:string;day:string;payload:string;commercialId:string;serverOrigin:string}>(`SELECT operation_id AS operationId,client_id AS clientId,invoice_day AS day,payload,commercial_id AS commercialId,server_origin AS serverOrigin
 FROM day_invoice_payments WHERE client_id=? AND invoice_day=? ORDER BY rowid`,clientId,day);
 return rows.map(row=>{
  if(row.commercialId!==identity.commercialId || row.serverOrigin!==identity.serverOrigin) throw Error('Paiement lié à un autre commercial ou serveur.');
  let payment:DayInvoicePayment; try { payment=JSON.parse(row.payload);validateDayPayment(payment); } catch { throw Error('Paiement local illisible.'); }
  if(payment.operationId!==row.operationId || payment.clientId!==row.clientId || payment.day!==row.day) throw Error('Paiement local incohérent.');
  return payment;
 });
}

/** Capture la file entière ; une ligne orpheline ou modifiée bloque l'envoi,
 * elle ne doit jamais disparaître à cause d'une jointure interne. */
export async function readDayInvoiceOutbox(tx:Tx,identity:DayInvoiceIdentity):Promise<DayInvoiceQueueEntry[]> {
 assertIdentity(identity);
 const rows=await tx.getAllAsync<DayInvoiceQueueEntry & {originalPayload:string|null;originalCommercialId:string|null;originalServerOrigin:string|null;originalClientId:string|null;originalDay:string|null}>(`SELECT o.sequence,o.operation_id AS operationId,o.payload,o.commercial_id AS commercialId,o.server_origin AS serverOrigin,
 p.payload AS originalPayload,p.commercial_id AS originalCommercialId,p.server_origin AS originalServerOrigin,p.client_id AS originalClientId,p.invoice_day AS originalDay
 FROM day_invoice_payment_outbox o LEFT JOIN day_invoice_payments p ON p.operation_id=o.operation_id ORDER BY o.sequence LIMIT 20001`);
 if(rows.length>20000)throw Error('File de règlements trop longue : envoi incomplet refusé.');
 return rows.map(r=>{
  if(r.commercialId!==identity.commercialId||r.serverOrigin!==identity.serverOrigin||r.originalPayload!==r.payload||r.originalCommercialId!==r.commercialId||r.originalServerOrigin!==r.serverOrigin)throw Error('File de règlements incohérente ou liée à une autre identité.');
  let payment:DayInvoicePayment;try{payment=JSON.parse(r.payload);validateDayPayment(payment);}catch{throw Error('Paiement en attente illisible.');}
  if(payment.operationId!==r.operationId||payment.clientId!==r.originalClientId||payment.day!==r.originalDay)throw Error('Paiement en attente incohérent.');
  return {sequence:r.sequence,operationId:r.operationId,payload:r.payload,commercialId:r.commercialId,serverOrigin:r.serverOrigin};
 });
}
