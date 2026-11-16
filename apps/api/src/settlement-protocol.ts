/** Protocole des règlements identifiés et validation des anciennes dettes v6. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
const uuid=z.string().uuid(), money=z.number().int().safe().nonnegative();
export const settlementSchema=z.object({operationId:uuid,settlement:z.object({syncOperationId:uuid,createdAt:z.string().datetime(),clientId:uuid,clientName:z.string().trim().min(1).max(200),amount:money.positive(),mode:z.enum(['Espèces','Chèque','Virement']),chequeNumber:z.string().max(100),chequeBank:z.string().max(100),chequeDue:z.string().max(100)}).strict()}).strict();
/** Une preuve d'intégrité détecte les incohérences, mais ne protège pas contre
 * une modification simultanée du contenu et de son hachage en base. */
export function parseStoredOldDebt(row:{operation_id:unknown;client_id:unknown;journal_day:unknown;invoice_day:unknown;payload:unknown;payload_hash:unknown}){
 const event=settlementSchema.parse(row.payload),p=event.settlement;
 const d=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(p.createdAt));
 const hash=createHash('sha256').update(JSON.stringify(event)).digest('hex');
 if(event.operationId!==row.operation_id||p.syncOperationId!==event.operationId||p.clientId!==row.client_id||row.invoice_day!==row.journal_day||d!==row.invoice_day||hash!==row.payload_hash||(p.mode==='Chèque'&&(!p.chequeNumber.trim()||!p.chequeBank.trim()||!p.chequeDue.trim()))||(p.mode!=='Chèque'&&(p.chequeNumber||p.chequeBank||p.chequeDue)))throw Error('Règlement ancienne dette enregistré incohérent.');
 return event;
}
