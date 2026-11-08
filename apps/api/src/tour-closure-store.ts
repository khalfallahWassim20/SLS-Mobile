/** Préparation serveur isolée. Aucune route ne doit exposer une clôture avant raccordement
 * atomique à toutes les écritures et contrôle des opérations hors ligne. */
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {initialTourClosure,transitionTourClosure,type TourActor,type TourClosureState} from '@sls/domain';
import {journalDateSchema} from './journal-protocol.js';

export class ClosureConflict extends Error {}
const identifier=z.string().uuid();
function checkInputs(commercialId:string,day:string) {identifier.parse(commercialId);journalDateSchema.parse(day);}
function fromRow(commercialId:string,day:string,row: {status:'open'|'closed';version:number;closed_at:Date|string|null}|undefined):TourClosureState {
 if(!row) return initialTourClosure(commercialId,day);
 return {commercialId,day,status:row.status,version:row.version,closedAt:row.closed_at ? new Date(row.closed_at).toISOString():null};
}
/** Verrou unique par commercial et jour. À prendre dans la même transaction que toute écriture future. */
export async function lockTourClosure(db:PoolClient,commercialId:string,day:string):Promise<TourClosureState> {
 checkInputs(commercialId,day);
 // L'insertion concurrente sur la clé unique attend l'autre transaction même pour la première écriture.
 await db.query(`INSERT INTO tour_closures(commercial_id,journal_date,status,version) VALUES($1,$2::date,'open',0)
 ON CONFLICT(commercial_id,journal_date) DO NOTHING`,[commercialId,day]);
 const result=await db.query('SELECT status,version,closed_at FROM tour_closures WHERE commercial_id=$1 AND journal_date=$2::date FOR UPDATE',[commercialId,day]);
 return fromRow(commercialId,day,result.rows[0]);
}
export async function readTourClosure(pool:Pool,commercialId:string,day:string):Promise<TourClosureState> {
 checkInputs(commercialId,day);
 const result=await pool.query('SELECT status,version,closed_at FROM tour_closures WHERE commercial_id=$1 AND journal_date=$2::date',[commercialId,day]);
 return fromRow(commercialId,day,result.rows[0]);
}
/** L'acteur DOIT provenir de l'authentification serveur, jamais de la requête mobile. */
export async function changeTourClosure(pool:Pool,commercialId:string,day:string,action:'close'|'reopen',actor:TourActor,expectedVersion:number):Promise<TourClosureState> {
 checkInputs(commercialId,day);
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  const commercial=await db.query('SELECT id FROM commercials WHERE id=$1 AND deleted_at IS NULL',[commercialId]);
  if(!commercial.rows.length) throw new ClosureConflict('Commercial introuvable.');
  const state=await lockTourClosure(db,commercialId,day);
  let next;
  try {next=transitionTourClosure(state,action,actor,new Date().toISOString(),expectedVersion);}
  catch(error) {if(error instanceof RangeError) throw new ClosureConflict(error.message);throw error;}
  if(next.state.version>2147483647) throw new ClosureConflict('Trop de changements de clôture.');
  await db.query('UPDATE tour_closures SET status=$3,version=$4,closed_at=$5 WHERE commercial_id=$1 AND journal_date=$2::date',[commercialId,day,next.state.status,next.state.version,next.state.closedAt]);
  await db.query(`INSERT INTO tour_closure_events(id,commercial_id,journal_date,action,actor_id,actor_role,occurred_at,version)
   VALUES($1,$2,$3::date,$4,$5,$6,$7,$8)`,[randomUUID(),commercialId,day,action,actor.id,actor.role,next.event.at,next.event.version]);
  await db.query('COMMIT');return next.state;
 } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
