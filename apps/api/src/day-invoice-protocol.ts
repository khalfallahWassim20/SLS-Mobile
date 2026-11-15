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
