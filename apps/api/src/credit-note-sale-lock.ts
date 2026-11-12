/** Étape préparatoire non exposée. À appeler UNIQUEMENT dans une transaction
 * ouverte, avec un acteur authentifié par le serveur. Les verrous restent détenus
 * jusqu'au COMMIT/ROLLBACK de l'appelant. Cette fonction ne crée aucun avoir. */
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {CreditNoteActor,CreditNoteCommand} from '@sls/domain';
import {lockIdentifiedOperation,assertOperationUnambiguous,IdentifiedOverlap} from './identified-overlap.js';
import {lockTourClosure} from './tour-closure-store.js';
import {JournalConflict,TourDayClosed} from './journal-store.js';

const uuid=z.string().uuid();
const request=z.object({operationId:uuid,invoiceId:uuid,expectedVersion:z.number().int().min(1).max(999999),recordedAt:z.string().datetime({precision:3}),choice:z.enum(['refund','credit']).nullable()}).strict();
const savedSale=z.object({syncSaleId:uuid,syncVersion:z.number().int().min(1),clientId:uuid,createdAt:z.string().datetime(),total:z.number().int().safe().nonnegative(),paid:z.number().int().safe().nonnegative()}).passthrough();
function day(iso:string):string {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso));
 const part=(s:string)=>parts.find(p=>p.type===s)?.value;
 return `${part('year')}-${part('month')}-${part('day')}`;
}
/** Vérifie une NOUVELLE demande uniquement : l'appelant devra d'abord traiter
 * les reprises identiques depuis un registre persistant, sous verrou UUID global.
 * Les factures de l'ancien espace sont volontairement refusées ici. Le futur
 * service devra aussi vérifier sous ce verrou l'absence d'un précédent avoir,
 * l'unicité inter-types et enregistrer facture, avoir et mouvements ensemble. */
export async function lockCreditNoteSale(db:PoolClient,actor:CreditNoteActor,input:CreditNoteCommand) {
 const command=request.parse(input);
 if(new Date(command.recordedAt).toISOString()!==command.recordedAt)throw new RangeError('Date invalide');
 if(!actor || (actor.role!=='admin' && actor.role!=='commercial') || typeof actor.id!=='string' || !actor.id.trim())throw new RangeError('Acteur invalide');
 if(actor.role==='commercial')uuid.parse(actor.id);
 await lockIdentifiedOperation(db,command.operationId);
 await assertOperationUnambiguous(db,command.operationId,'sale');
 const collision=await db.query('SELECT 1 FROM identified_sale_events WHERE operation_id=$1',[command.operationId]);
 if(collision.rows.length)throw new IdentifiedOverlap('Identifiant d’opération déjà utilisé.');
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',['identified-sale',command.invoiceId]);
 const legacy=await db.query('SELECT 1 FROM demo_sale_events WHERE sale_id=$1 LIMIT 1',[command.invoiceId]);
 if(legacy.rows.length)throw new IdentifiedOverlap('Ancienne facture : rapprochement nécessaire avant avoir.');
 const rows=await db.query('SELECT version,commercial_id,journal_date::text AS day,payload FROM identified_sale_events WHERE sale_id=$1 ORDER BY version',[command.invoiceId]);
 if(!rows.rows.length || rows.rows[0].version!==1)throw new JournalConflict('Historique de facture incomplet.');
 const first=rows.rows[0],last=rows.rows[rows.rows.length-1];
 if(last.version!==command.expectedVersion)throw new JournalConflict('Version de facture périmée.');
 const sale=savedSale.parse(last.payload?.sale);
 if(sale.syncSaleId!==command.invoiceId || sale.syncVersion!==last.version || rows.rows.some((r,i)=>r.version!==i+1 || r.day!==first.day) || day(sale.createdAt)!==first.day)throw new JournalConflict('Historique de facture incohérent.');
 const lastTime=last.payload?.recordedAt;
 if(typeof lastTime!=='string' || !Number.isFinite(Date.parse(lastTime)) || Date.parse(command.recordedAt)<Date.parse(lastTime))throw new JournalConflict('Date de l’avoir antérieure à la dernière version.');
 const keys=new Map<string,{id:string;day:string}>();
 const add=(id:string,date:string)=>keys.set(`${id}:${date}`,{id,day:date});
 add(first.commercial_id,first.day);add(first.commercial_id,day(command.recordedAt));
 if(actor.role==='commercial'){add(actor.id,first.day);add(actor.id,day(command.recordedAt));}
 for(const key of [...keys.keys()].sort()){
  const k=keys.get(key)!;const closure=await lockTourClosure(db,k.id,k.day);
  if(closure.status!=='open')throw new TourDayClosed(k.day,k.id);
 }
 return {invoiceId:command.invoiceId,version:last.version as number,total:sale.total,netPaid:sale.paid,clientId:sale.clientId,ownerId:first.commercial_id as string,invoiceDay:first.day as string};
}
