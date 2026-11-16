/** Validation du futur protocole de règlement du jour. Aucune route active. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {validateDayPayment,type DayInvoicePayment} from '../../../packages/domain/src/day-invoice.js';
const uuid=z.string().uuid();
const version=z.number().int().safe().min(1).max(1000000);
const source=z.object({id:uuid,version}).strict();
const payload=z.object({
 operationId:uuid,clientId:uuid,day:z.string(),recordedAt:z.string(),amount:z.number().int().safe().nonnegative(),
 mode:z.enum(['Espèces','Chèque','Virement','Crédit']),chequeNumber:z.string().max(100),chequeBank:z.string().max(100),chequeDue:z.string().max(100),
 preInvoice:z.object({id:uuid,version,total:z.number().int().safe().positive(),declare:z.boolean()}).strict().nullable(),
 sales:z.array(source).max(1000)
}).strict();
/** Conserve une représentation unique, refuse propriétés inconnues et dates incohérentes. */
export function parseDayInvoicePayment(input:unknown):DayInvoicePayment {
 const parsed=payload.parse(input);validateDayPayment(parsed);return parsed;
}
/** Hachage stable des seules propriétés validées, indépendant de l'ordre JSON reçu. */
export function dayInvoicePaymentHash(input:unknown):string {
 return createHash('sha256').update(JSON.stringify(parseDayInvoicePayment(input))).digest('hex');
}

/** Vérifie le contenu enregistré et ses colonnes d'index avant de le prendre
 * en compte ou d'accuser une reprise. Le hachage détecte les incohérences,
 * il ne constitue pas une preuve cryptographique contre une base compromise. */
export function parseStoredDayInvoicePayment(row:{operation_id:unknown;client_id:unknown;invoice_day:unknown;event_day:unknown;payload:unknown;payload_hash:unknown}):DayInvoicePayment {
 const payment=parseDayInvoicePayment(row.payload);
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(payment.recordedAt));
 const get=(name:string)=>parts.find(p=>p.type===name)?.value;
 const eventDay=`${get('year')}-${get('month')}-${get('day')}`;
 if(payment.operationId!==row.operation_id||payment.clientId!==row.client_id||payment.day!==row.invoice_day||eventDay!==row.event_day||dayInvoicePaymentHash(payment)!==row.payload_hash)throw Error('Paiement du jour enregistré incohérent.');
 return payment;
}
