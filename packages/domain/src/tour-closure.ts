/** Règles pures de clôture, non reliées aux écrans, à la base ni à l'authentification.
 * Le rôle et l'identité doivent être fournis par le serveur authentifié, jamais crus sur parole depuis le mobile. */
export type TourActor = { id:string; role:'commercial'|'admin' };
export type TourClosureState = { commercialId:string; day:string; status:'open'|'closed'; version:number; closedAt:string|null };
export type TourClosureEvent = { commercialId:string; day:string; action:'close'|'reopen'; actorId:string; actorRole:'commercial'|'admin'; at:string; version:number };
function identifier(value: unknown): value is string { return typeof value === 'string' && value.trim().length>0 && value.length<=200; }
function dayIsValid(value: unknown): value is string {
 if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
 const parsed=new Date(`${value}T00:00:00Z`);
 return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0,10)===value;
}
function dateTimeIsValid(value: unknown): value is string {
 if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
 const d=new Date(value); return !Number.isNaN(d.getTime()) && d.toISOString()===value;
}
function validateState(state:TourClosureState):void {
 if(!identifier(state.commercialId) || !dayIsValid(state.day) || !Number.isSafeInteger(state.version) || state.version<0 || !['open','closed'].includes(state.status) || (state.status==='open' ? state.closedAt!==null : state.version<1 || !dateTimeIsValid(state.closedAt))) throw new RangeError('État de clôture invalide.');
}
export function initialTourClosure(commercialId:string,day:string): TourClosureState {
 const state:TourClosureState={commercialId,day,status:'open',version:0,closedAt:null}; validateState(state); return state;
}
/** Une opération de la journée clôturée doit être refusée par toutes les voies d'écriture. */
export function assertTourWritable(state:TourClosureState):void {
 validateState(state);
 if(state.status==='closed') throw new RangeError('Journal clôturé : seule une réouverture par l’administrateur permet une correction.');
}
export function transitionTourClosure(state:TourClosureState, action:'close'|'reopen', actor:TourActor, at:string, expectedVersion:number): {state:TourClosureState;event:TourClosureEvent} {
 validateState(state);
 if (!identifier(actor?.id) || (actor.role!=='commercial' && actor.role!=='admin')) throw new RangeError('Utilisateur invalide.');
 if (!dateTimeIsValid(at)) throw new RangeError('Date de l’opération invalide.');
 if (!Number.isSafeInteger(expectedVersion) || expectedVersion!==state.version || state.version===Number.MAX_SAFE_INTEGER) throw new RangeError('Version du journal incohérente : actualisez avant de continuer.');
 if (action==='close') {
   if (state.status==='closed') throw new RangeError('Journal déjà clôturé.');
   if (actor.role==='commercial' && actor.id!==state.commercialId) throw new RangeError('Ce journal appartient à un autre commercial.');
 } else if (action==='reopen') {
   if (actor.role!=='admin') throw new RangeError('Seul l’administrateur peut rouvrir le journal.');
   if (state.status!=='closed') throw new RangeError('Journal déjà ouvert.');
 } else throw new RangeError('Action de clôture invalide.');
 const version=state.version+1;
 return {state:{...state,status:action==='close'?'closed':'open',version,closedAt:action==='close'?at:null},event:{commercialId:state.commercialId,day:state.day,action,actorId:actor.id,actorRole:actor.role,at,version}};
}
