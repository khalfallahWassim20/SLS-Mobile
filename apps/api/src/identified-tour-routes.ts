/** Routes individuelles ; les routes v5 restent désactivées sauf option de test explicite. */
import {Router,type RequestHandler} from 'express';
import {rateLimit} from 'express-rate-limit';
import {ZodError,z} from 'zod';
import type {Pool} from 'pg';
import {verifyCommercialSession} from './commercial-session.js';
import {ClosureAuthenticationError,ClosureConflict,ClosureProofConflict,ClosureAbandoned,abandonTourClose,readTourClosure,requestTourTransition} from './tour-closure-store.js';
import {JournalAuthenticationError,JournalConflict,TourDayClosed,storeJournalSnapshot} from './journal-store.js';
import {readLocalSaleHistoryPrototype} from './local-sale-history-prototype.js';
import {readRemoteSaleReceiptPrototype} from './remote-sale-receipt-prototype.js';
import {abandonRemoteSalePrototype} from './remote-sale-abandon-prototype.js';
import {abandonCreditNotePrototype} from './credit-note-abandon-prototype.js';
import {storeIdentifiedSale,storeIdentifiedSettlement} from './identified-operations.js';
import {readIdentifiedReference,ReferenceOverlap} from './identified-reference.js';
import {readIdentifiedJournalDay} from './identified-journal-day.js';
import {IdentifiedOverlap} from './identified-overlap.js';
import {CreditProtocolUpgradeRequired} from './credit-note-active-guards.js';
import {readPrototypeCreditReference} from './credit-note-reference-prototype.js';
import {readPrototypeCreditJournal} from './credit-note-journal-prototype.js';
import {readJournalCashReconciliation} from './journal-cash-reconciliation-prototype.js';
import {readSaleCashPreview} from './sale-cash-preview-prototype.js';
import {journalDateSchema} from './journal-protocol.js';
import {readPrototypeCreditSources} from './credit-note-sources-prototype.js';
import {prototypeCommercialCreditRoutes,prototypeAdminCreditRoutes} from './credit-note-routes-prototype.js';
import {IdentifiedSyncDisabled,assertIdentifiedMode,readSyncMode,lockSyncMode} from './tour-sync-mode.js';

const input=z.object({requestId:z.string().uuid(),day:z.string(),expectedVersion:z.number().int().min(0),adminRefundProof:z.array(z.object({noteOperationId:z.string().uuid(),assignmentId:z.string().uuid(),refund:z.number().int().safe().positive()}).strict()).max(10000).optional(),cashProof:z.string().regex(/^[0-9a-f]{64}$/).optional()}).strict();
const bearer=(value:string|undefined)=>value?.match(/^Bearer (.+)$/)?.[1]??'';
function errorHandler(error:unknown,res:import('express').Response,next:import('express').NextFunction) {
 if(error instanceof ClosureAuthenticationError || error instanceof JournalAuthenticationError) {res.status(401).json({error:'Session invalide ou expirée.'});return;}
 if(error instanceof TourDayClosed) {res.status(409).json({error:error.message,code:'TOUR_DAY_CLOSED',day:error.day,commercialId:error.commercialId});return;}
 if(error instanceof CreditProtocolUpgradeRequired) {res.status(409).json({error:error.message,code:'CREDIT_PROTOCOL_UPGRADE_REQUIRED'});return;}
 if(error instanceof ClosureProofConflict || error instanceof ClosureAbandoned) {res.status(409).json({error:error.message,code:error instanceof ClosureProofConflict?'CLOSURE_REFUND_PROOF_STALE':'CLOSURE_REQUEST_ABANDONED'});return;}
 if(error instanceof ClosureConflict || error instanceof JournalConflict || error instanceof ReferenceOverlap || error instanceof IdentifiedOverlap || error instanceof IdentifiedSyncDisabled) {res.status(409).json({error:error.message});return;}
 if(error instanceof ZodError || error instanceof RangeError) {res.status(400).json({error:'Données invalides.'});return;}
 next(error);
}
export function identifiedCommercialRoutes(pool:Pool,secret:string,options:{enforceMode?:boolean;allowCreditProtocol?:boolean}={}) {
 const enforceMode=options.enforceMode!==false;
 if(options.allowCreditProtocol&&!enforceMode)throw Error('Le protocole d’avoirs exige le mode individuel.');
 const r=Router();r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 r.use(rateLimit({windowMs:15*60*1000,limit:500,standardHeaders:'draft-8',legacyHeaders:false}));
 const supportsCredit=(req:import('express').Request)=>options.allowCreditProtocol===true&&req.get('X-SLS-Reference-Version')==='5';
 // Lecture uniquement : cet identifiant ne permet pas de changer une liaison.
 // Il n'est exploitable qu'après enregistrement préalable auprès d'un serveur
 // connu ; une ancienne installation non épinglée reste à rapprocher.
 r.get('/server-lineage',async(req,res,next)=>{try{
  const actor=await verifyCommercialSession(pool,secret,bearer(req.get('Authorization')));
  if(!actor){res.status(401).json({error:'Session invalide ou expirée.'});return;}
  const result=await pool.query('SELECT lineage_id AS "lineageId" FROM server_lineage_identity WHERE id=1');
  if(result.rows.length!==1||!z.string().uuid().safeParse(result.rows[0].lineageId).success)throw new Error('Identité de base indisponible.');
  res.json({version:1,commercialId:actor.id,lineageId:result.rows[0].lineageId});
 }catch(e){errorHandler(e,res,next);}});

 r.get('/reference',async(req,res,next)=>{try{const actor=await verifyCommercialSession(pool,secret,bearer(req.get('Authorization')));if(!actor){res.status(401).json({error:'Session invalide ou expirée.'});return;}res.json(supportsCredit(req)?await readPrototypeCreditReference(pool,false):await readIdentifiedReference(pool,false,enforceMode));}catch(e){errorHandler(e,res,next);}});
 // Uniquement pour une base de test isolée, jamais activé par défaut.
 if(options.allowCreditProtocol===true)r.post('/credit-notes-abandon',async(req,res,next)=>{try{
  if(!supportsCredit(req)){res.status(409).json({error:'Référence v5 requise.'});return;}
  res.json(await abandonCreditNotePrototype(pool,req.body,{secret,token:bearer(req.get('Authorization'))}));
 }catch(e){errorHandler(e,res,next);}});
 if(options.allowCreditProtocol===true)r.use('/credit-notes',(req,res,next)=>{if(!supportsCredit(req)){res.status(409).json({error:'Référence v5 requise.'});return;}next();},prototypeCommercialCreditRoutes(pool,secret));
 if(options.allowCreditProtocol===true)r.post('/remote-sale-edits/abandon',async(req,res,next)=>{try{
  if(!supportsCredit(req)){res.status(409).json({error:'Référence v5 requise.'});return;}
  const result=await abandonRemoteSalePrototype(pool,req.body,{secret,token:bearer(req.get('Authorization'))});res.json(result);
 }catch(e){errorHandler(e,res,next);}});
 if(options.allowCreditProtocol===true)r.get('/local-sales/:saleId/history',async(req,res,next)=>{try{
  if(!supportsCredit(req)){res.status(409).json({error:'Référence v5 requise.'});return;}
  const result=await readLocalSaleHistoryPrototype(pool,req.params.saleId,{secret,token:bearer(req.get('Authorization'))});
  if(!result){res.status(404).json({error:'Historique indisponible pour ce commercial.'});return;}res.json(result);
 }catch(e){errorHandler(e,res,next);}});
 if(options.allowCreditProtocol===true)r.get('/remote-sale-edits/:operationId/receipt',async(req,res,next)=>{try{
  if(!supportsCredit(req)){res.status(409).json({error:'Référence v5 requise.'});return;}
  const result=await readRemoteSaleReceiptPrototype(pool,req.params.operationId,{secret,token:bearer(req.get('Authorization'))});
  if(!result){res.status(404).json({error:'Preuve indisponible ; la demande reste en attente.'});return;}res.json(result);
 }catch(e){errorHandler(e,res,next);}});
 if(options.allowCreditProtocol===true)r.get('/credit-sources/:clientId',async(req,res,next)=>{try{
  const actor=await verifyCommercialSession(pool,secret,bearer(req.get('Authorization')));if(!actor){res.status(401).json({error:'Session invalide ou expirée.'});return;}
  if(!supportsCredit(req)){res.status(409).json({error:'Référence v5 requise.'});return;}
  const data=await readPrototypeCreditSources(pool,req.params.clientId);if(!data){res.status(404).json({error:'Client introuvable.'});return;}res.json(data);
 }catch(e){errorHandler(e,res,next);}});
 // Comparaison informative des seules ventes ; ne valide ni ne clôture la caisse.
 if(options.allowCreditProtocol===true)r.get('/day/:day/sale-cash',async(req,res,next)=>{try{
  const actor=await verifyCommercialSession(pool,secret,bearer(req.get('Authorization')));if(!actor){res.status(401).json({error:'Session invalide ou expirée.'});return;}
  if(!supportsCredit(req)){res.status(409).json({error:'Référence v5 requise.'});return;}
  const day=journalDateSchema.parse(req.params.day),db=await pool.connect();
  try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));
   const cash=await readSaleCashPreview(db,actor.id,day);await db.query('COMMIT');
   if(!cash.available){res.status(409).json({error:cash.reason});return;}
   res.json({version:5,commercialId:actor.id,day,initialEvents:cash.initialEvents,refundEvents:cash.refundEvents.map(({operationId,saleId,clientId,recordedAt,refund})=>({operationId,saleId,clientId,recordedAt,refund}))});
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }catch(e){errorHandler(e,res,next);}});
 if(options.allowCreditProtocol===true)r.get('/day/:day/journal-cash',async(req,res,next)=>{try{
  const actor=await verifyCommercialSession(pool,secret,bearer(req.get('Authorization')));if(!actor){res.status(401).json({error:'Session invalide ou expirée.'});return;}
  if(!supportsCredit(req)){res.status(409).json({error:'Référence v5 requise.'});return;}
  const db=await pool.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');assertIdentifiedMode(await lockSyncMode(db));const result=await readJournalCashReconciliation(db,actor.id,req.params.day);await db.query('COMMIT');res.json(result);}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }catch(e){errorHandler(e,res,next);}});
 r.get('/day/:day/details',async(req,res,next)=>{try{const actor=await verifyCommercialSession(pool,secret,bearer(req.get('Authorization')));if(!actor){res.status(401).json({error:'Session invalide ou expirée.'});return;}const {closureEvents:_adminHistory,...details}=supportsCredit(req)?await readPrototypeCreditJournal(pool,actor.id,req.params.day):await readIdentifiedJournalDay(pool,actor.id,req.params.day,enforceMode);res.json(details);}catch(e){errorHandler(e,res,next);}});
 r.get('/day/:day',async(req,res,next)=>{try{const actor=await verifyCommercialSession(pool,secret,bearer(req.get('Authorization')));if(!actor){res.status(401).json({error:'Session invalide ou expirée.'});return;}if(enforceMode)assertIdentifiedMode(await readSyncMode(pool));res.json(await readTourClosure(pool,actor.id,req.params.day));}catch(e){errorHandler(e,res,next);}});
 if(options.allowCreditProtocol===true)r.post('/close/abandon',async(req,res,next)=>{try{if(!supportsCredit(req)){res.status(409).json({error:'Référence v5 requise.'});return;}res.json(await abandonTourClose(pool,req.body,{secret,token:bearer(req.get('Authorization'))}));}catch(e){errorHandler(e,res,next);}});
 r.post('/close',async(req,res,next)=>{try{const data=input.parse(req.body);const result=await requestTourTransition(pool,data,{kind:'commercial',secret,token:bearer(req.get('Authorization'))},enforceMode,supportsCredit(req),options.allowCreditProtocol===true);res.status(result.status==='received'?201:200).json(result);}catch(e){errorHandler(e,res,next);}});
 for(const kind of ['journal','sales','settlements'] as const) r.post('/'+kind,async(req,res,next)=>{try{
  const session={secret,token:bearer(req.get('Authorization')),enforceMode,creditAware:supportsCredit(req)};
  const status=kind==='journal'?await storeJournalSnapshot(pool,req.body,'identified',session):kind==='sales'?await storeIdentifiedSale(pool,req.body,session):await storeIdentifiedSettlement(pool,req.body,session);
  res.status(status==='received'?201:200).json({status,operationId:req.body.operationId});
 }catch(e){errorHandler(e,res,next);}});
 return r;
}
/** Le middleware admin doit vérifier réellement la session. Le nom de l'admin est configuré côté serveur. */
export function identifiedAdminRoutes(pool:Pool,authenticateAdmin:RequestHandler,adminName:string,options:{enforceMode?:boolean;allowCreditProtocol?:boolean}={}) {
 const enforceMode=options.enforceMode!==false;
 if(options.allowCreditProtocol&&!enforceMode)throw Error('Le protocole d’avoirs exige le mode individuel.');
 const r=Router();r.use(authenticateAdmin);r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 // Désactivé par défaut. L'authentification est imposée par ce
 // routeur parent, avant même de vérifier la version ou de traiter la requête.
 if(options.allowCreditProtocol===true)r.use('/credit-notes',(req,res,next)=>{if(req.get('X-SLS-Reference-Version')!=='5'){res.status(409).json({error:'Référence v5 requise.'});return;}next();},prototypeAdminCreditRoutes(pool,(_req,_res,next)=>next(),adminName));
 r.post('/:commercialId/reopen',async(req,res,next)=>{try{const data=input.parse(req.body);const result=await requestTourTransition(pool,data,{kind:'admin',actorId:adminName,commercialId:req.params.commercialId},enforceMode,options.allowCreditProtocol===true&&req.get('X-SLS-Reference-Version')==='5');res.status(result.status==='received'?201:200).json(result);}catch(e){errorHandler(e,res,next);}});
 return r;
}
