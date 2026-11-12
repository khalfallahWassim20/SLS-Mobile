/** Préparation locale isolée ; pas reliée aux écrans ou écritures actuelles.
 * Toutes les fonctions doivent être appelées dans une transaction exclusive SQLite. */
type Bind=string|number|null;
type Tx={getFirstAsync<T>(sql:string,...params:Bind[]):Promise<T|null>;runAsync(sql:string,...params:Bind[]):Promise<unknown>};
export type AdminRefundProof={noteOperationId:string;assignmentId:string;refund:number}[];
export type Attempt={commercialId:string;day:string;requestId:string;expectedVersion:number;status:'closing'|'closed';closedVersion:number|null;adminRefundProof?:AdminRefundProof};
export const tourCloseQueueSchema=`CREATE TABLE IF NOT EXISTS tour_close_attempts (
 commercial_id TEXT NOT NULL, journal_date TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
 expected_version INTEGER NOT NULL CHECK(expected_version>=0), status TEXT NOT NULL CHECK(status IN ('closing','closed')),
 closed_version INTEGER, PRIMARY KEY(commercial_id,journal_date),
 CHECK((status='closing' AND closed_version IS NULL) OR (status='closed' AND closed_version=expected_version+1))
);
CREATE TABLE IF NOT EXISTS tour_close_admin_refund_proofs (request_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tour_known_server_states (
 commercial_id TEXT NOT NULL, journal_date TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','closed')),
 version INTEGER NOT NULL CHECK(version>=0), PRIMARY KEY(commercial_id,journal_date)
);`;
const isUuid=(x:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
function valid(commercialId:string,day:string) {
 const parsed=new Date(`${day}T00:00:00.000Z`);
 if(!isUuid(commercialId)||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==day)throw Error('Commercial ou date invalide.');
}
export async function findTourCloseAttempt(tx:Tx,commercialId:string,day:string):Promise<Attempt|null> {
 valid(commercialId,day);
 const attempt=await tx.getFirstAsync<Attempt>(`SELECT commercial_id AS commercialId,journal_date AS day,request_id AS requestId,
 expected_version AS expectedVersion,status,closed_version AS closedVersion FROM tour_close_attempts WHERE commercial_id=? AND journal_date=?`,commercialId,day);
 if(!attempt)return null;
 const stored=await tx.getFirstAsync<{payload:string}>('SELECT payload FROM tour_close_admin_refund_proofs WHERE request_id=?',attempt.requestId);
 if(!stored)return attempt;
 let proof:unknown;try{proof=JSON.parse(stored.payload);}catch{throw Error('Preuve de clôture illisible.');}
 if(!Array.isArray(proof)||proof.length>10000||proof.some((p,i)=>!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).sort().join(',')!=='assignmentId,noteOperationId,refund'||typeof p.noteOperationId!=='string'||!isUuid(p.noteOperationId)||typeof p.assignmentId!=='string'||!isUuid(p.assignmentId)||!Number.isSafeInteger(p.refund)||p.refund<=0||(i>0&&proof[i-1].noteOperationId>=p.noteOperationId)))throw Error('Preuve de clôture invalide.');
 return {...attempt,adminRefundProof:proof as AdminRefundProof};
}
/** Verrou de précaution local, pas un substitut au contrôle serveur. */
export async function assertLocalTourWritable(tx:Tx,commercialId:string,day:string) {
 valid(commercialId,day);const attempt=await findTourCloseAttempt(tx,commercialId,day);
 if(attempt) throw Error(attempt.status==='closing'?'Clôture en attente de réponse du serveur.':'Journée clôturée : réouverture administrateur nécessaire.');
 const known=await tx.getFirstAsync<{status:string}>('SELECT status FROM tour_known_server_states WHERE commercial_id=? AND journal_date=?',commercialId,day);
 if(known?.status==='closed')throw Error('Journée clôturée : réouverture administrateur nécessaire.');
}
/** Ne jamais clôturer pendant une file locale incomplète ou une donnée historique sans preuve de synchronisation. */
export async function prepareTourClose(tx:Tx,commercialId:string,day:string,expectedVersion:number,uuid:()=>string):Promise<Attempt> {
 valid(commercialId,day);
 if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0||expectedVersion>=2147483647) throw Error('Version de clôture invalide.');
 const previous=await findTourCloseAttempt(tx,commercialId,day);
 if(previous) {
  if(previous.status==='closing' && previous.expectedVersion===expectedVersion)return previous;
  throw Error('Une clôture existe déjà pour cette journée.');
 }
 const known=await tx.getFirstAsync<{status:string;version:number}>('SELECT status,version FROM tour_known_server_states WHERE commercial_id=? AND journal_date=?',commercialId,day);
 if(known && (known.status!=='open'||known.version!==expectedVersion))throw Error('État de clôture périmé ou déjà clôturé : actualisez la journée.');
 // Conservateur sur toutes les journées : on ne sait pas encore attribuer les anciennes files.
 const pending=await tx.getFirstAsync<{pending:number}>(`SELECT
  EXISTS(SELECT 1 FROM sales_outbox) OR EXISTS(SELECT 1 FROM journal_sync_outbox)
  OR EXISTS(SELECT 1 FROM tour_pre_invoices p LEFT JOIN journal_sync_state s ON s.invoice_id=p.id WHERE s.invoice_id IS NULL)
  OR EXISTS(SELECT 1 FROM sales WHERE CASE WHEN json_valid(payload) THEN json_extract(payload,'$.syncSaleId') IS NULL ELSE 1 END)
  OR EXISTS(SELECT 1 FROM settlements WHERE CASE WHEN json_valid(payload) THEN json_extract(payload,'$.syncOperationId') IS NULL ELSE 1 END) AS pending`);
 if(!pending || pending.pending)throw Error('Des opérations locales en attente ou anciennes nécessitent une synchronisation ou un rapprochement avant clôture.');
 const requestId=uuid();if(!isUuid(requestId))throw Error('Identifiant de clôture invalide.');
 await tx.runAsync('INSERT INTO tour_close_attempts(commercial_id,journal_date,request_id,expected_version,status,closed_version) VALUES(?,?,?,?,?,NULL)',commercialId,day,requestId,expectedVersion,'closing');
 return {commercialId,day,requestId,expectedVersion,status:'closing',closedVersion:null};
}
/** Vérifie tous les champs avant de conserver l'accusé ; une réponse douteuse ne libère pas les écritures. */
export async function acknowledgeTourClose(tx:Tx,commercialId:string,day:string,response:unknown):Promise<void> {
 valid(commercialId,day);const attempt=await findTourCloseAttempt(tx,commercialId,day);
 if(!attempt || attempt.status!=='closing')throw Error('Aucune clôture en attente.');
 if(typeof response!=='object'||response===null||Array.isArray(response))throw Error('Accusé de clôture invalide.');
 const r=response as Record<string,unknown>;
 if((r.status!=='received'&&r.status!=='duplicate')||r.requestId!==attempt.requestId||r.commercialId!==commercialId||r.day!==day||r.action!=='close'||r.version!==attempt.expectedVersion+1)throw Error('Accusé de clôture invalide.');
 await tx.runAsync('UPDATE tour_close_attempts SET status=?,closed_version=? WHERE commercial_id=? AND journal_date=?','closed',attempt.expectedVersion+1,commercialId,day);
}
/** Effacer uniquement après réservation serveur de l'UUID ; une clôture déjà
 * reçue ne peut jamais être abandonnée et son accusé doit être repris. */
export async function acknowledgeAbandonedTourClose(tx:Tx,commercialId:string,day:string,expected:Attempt,response:unknown):Promise<void>{
 valid(commercialId,day);const attempt=await findTourCloseAttempt(tx,commercialId,day);
 if(!attempt||attempt.status!=='closing'||attempt.requestId!==expected.requestId||attempt.expectedVersion!==expected.expectedVersion||JSON.stringify(attempt.adminRefundProof??null)!==JSON.stringify(expected.adminRefundProof??null))throw Error('Tentative de clôture modifiée : abandon refusé.');
 if(!response||typeof response!=='object'||Array.isArray(response))throw Error('Accusé d’abandon invalide.');
 const r=response as Record<string,unknown>;
 if(Object.keys(r).sort().join(',')!=='commercialId,day,expectedVersion,requestId,status'||r.requestId!==attempt.requestId||r.commercialId!==commercialId||r.day!==day||r.expectedVersion!==attempt.expectedVersion)throw Error('Accusé d’abandon invalide.');
 if(r.status==='already-received')throw Error('Clôture déjà reçue par le serveur : reprenez son accusé.');
 if(r.status!=='abandoned')throw Error('Accusé d’abandon invalide.');
 await tx.runAsync('DELETE FROM tour_close_admin_refund_proofs WHERE request_id=?',attempt.requestId);
 await tx.runAsync('DELETE FROM tour_close_attempts WHERE commercial_id=? AND journal_date=?',commercialId,day);
}
/** Appeler uniquement après lecture authentifiée de l'état serveur ; jamais sur une simple erreur réseau. */
export async function applyReopenedServerState(tx:Tx,commercialId:string,day:string,state:unknown):Promise<boolean> {
 valid(commercialId,day);const attempt=await findTourCloseAttempt(tx,commercialId,day);
 if(!attempt || attempt.status!=='closed')return false;
 if(typeof state!=='object'||state===null||Array.isArray(state))throw Error('État serveur invalide.');
 const s=state as Record<string,unknown>;
 if(s.commercialId!==commercialId||s.day!==day||s.status!=='open'||!Number.isSafeInteger(s.version)||(s.version as number)<=attempt.closedVersion!)throw Error('Réouverture serveur non confirmée.');
 await tx.runAsync('DELETE FROM tour_close_admin_refund_proofs WHERE request_id=?',attempt.requestId);
 await tx.runAsync('DELETE FROM tour_close_attempts WHERE commercial_id=? AND journal_date=?',commercialId,day);return true;
}

/** Envoie la demande immuable ; l'accusé doit être enregistré par le callback transactionnel.
 * Sur erreur réseau/accusé, le callback n'efface rien et la même demande peut être renvoyée. */
export async function sendPreparedTourClose(attempt:Attempt,
 send:(body:{requestId:string;day:string;expectedVersion:number;adminRefundProof?:AdminRefundProof})=>Promise<{ok:boolean;status:number;json:()=>Promise<unknown>}>,
 acknowledge:(response:unknown)=>Promise<void>):Promise<void> {
 if(attempt.status!=='closing')throw Error('Aucune clôture en attente.');
 const response=await send({requestId:attempt.requestId,day:attempt.day,expectedVersion:attempt.expectedVersion,...(attempt.adminRefundProof===undefined?{}:{adminRefundProof:attempt.adminRefundProof})});
 const body=await response.json().catch(()=>null);
 if(!response.ok) {
  const data=typeof body==='object'&&body!==null&&!Array.isArray(body)?body as Record<string,unknown>:null;
  throw Error(typeof data?.error==='string'&&data.error?data.error.slice(0,300):`Erreur clôture (${response.status}).`);
 }
 await acknowledge(body);
}

/** Conserver un état serveur authentifié et refuser toute régression ou changement sans nouvelle version.
 * N'autorise jamais une tentative dont l'accusé reste incertain à être effacée. */
export async function observeVerifiedTourState(tx:Tx,commercialId:string,day:string,state:unknown):Promise<void> {
 valid(commercialId,day);
 if(typeof state!=='object'||state===null||Array.isArray(state))throw Error('État serveur invalide.');
 const s=state as Record<string,unknown>;
 if(s.commercialId!==commercialId||s.day!==day||(s.status!=='open'&&s.status!=='closed')||!Number.isSafeInteger(s.version)||(s.version as number)<0||(s.version as number)>2147483647)throw Error('État serveur invalide.');
 const known=await tx.getFirstAsync<{status:string;version:number}>('SELECT status,version FROM tour_known_server_states WHERE commercial_id=? AND journal_date=?',commercialId,day);
 if(known && ((s.version as number)<known.version || (s.version===known.version && s.status!==known.status)))throw Error('État serveur périmé ou incohérent.');
 await tx.runAsync(`INSERT INTO tour_known_server_states(commercial_id,journal_date,status,version) VALUES(?,?,?,?)
 ON CONFLICT(commercial_id,journal_date) DO UPDATE SET status=excluded.status,version=excluded.version`,commercialId,day,s.status,s.version as number);
 if(s.status==='open') {
  const attempt=await findTourCloseAttempt(tx,commercialId,day);
  if(attempt?.status==='closed' && (s.version as number)>attempt.closedVersion!)await applyReopenedServerState(tx,commercialId,day,state);
 }
}
