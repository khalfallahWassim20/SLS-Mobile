/** Routeurs isolés pour tests, non montés sur le serveur de l'application. */
import {Router,type RequestHandler} from 'express';
import {rateLimit} from 'express-rate-limit';
import {ZodError,z} from 'zod';
import type {Pool} from 'pg';
import {verifyCommercialSession} from './commercial-session.js';
import {ClosureAuthenticationError,ClosureConflict,readTourClosure,requestTourTransition} from './tour-closure-store.js';
import {JournalAuthenticationError,JournalConflict,TourDayClosed,storeJournalSnapshot} from './journal-store.js';
import {readRemoteSaleReceiptPrototype} from './remote-sale-receipt-prototype.js';
import {abandonRemoteSalePrototype} from './remote-sale-abandon-prototype.js';
import {storeIdentifiedSale,storeIdentifiedSettlement} from './identified-operations.js';
import {readIdentifiedReference,ReferenceOverlap} from './identified-reference.js';
import {readIdentifiedJournalDay} from './identified-journal-day.js';
import {IdentifiedOverlap} from './identified-overlap.js';
import {CreditProtocolUpgradeRequired} from './credit-note-active-guards.js';
import {readPrototypeCreditReference} from './credit-note-reference-prototype.js';
import {readPrototypeCreditJournal} from './credit-note-journal-prototype.js';
import {readPrototypeCreditSources} from './credit-note-sources-prototype.js';
import {prototypeCommercialCreditRoutes,prototypeAdminCreditRoutes} from './credit-note-routes-prototype.js';
import {IdentifiedSyncDisabled,assertIdentifiedMode,readSyncMode} from './tour-sync-mode.js';

const input=z.object({requestId:z.string().uuid(),day:z.string(),expectedVersion:z.number().int().min(0)}).strict();
const bearer=(value:string|undefined)=>value?.match(/^Bearer (.+)$/)?.[1]??'';
function errorHandler(error:unknown,res:import('express').Response,next:import('express').NextFunction) {
 if(error instanceof ClosureAuthenticationError || error instanceof JournalAuthenticationError) {res.status(401).json({error:'Session invalide ou expirée.'});return;}
 if(error instanceof TourDayClosed) {res.status(409).json({error:error.message,code:'TOUR_DAY_CLOSED',day:error.day,commercialId:error.commercialId});return;}
 if(error instanceof CreditProtocolUpgradeRequired) {res.status(409).json({error:error.message,code:'CREDIT_PROTOCOL_UPGRADE_REQUIRED'});return;}
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
 r.get('/reference',async(req,res,next)=>{try{const actor=await verifyCommercialSession(pool,secret,bearer(req.get('Authorization')));if(!actor){res.status(401).json({error:'Session invalide ou expirée.'});return;}res.json(supportsCredit(req)?await readPrototypeCreditReference(pool,false):await readIdentifiedReference(pool,false,enforceMode));}catch(e){errorHandler(e,res,next);}});
 // Expérimental uniquement : cette option ne doit pas être activée par server.ts
 // avant le raccordement complet des écrans, soldes, historiques et exports.
 if(options.allowCreditProtocol===true)r.use('/credit-notes',(req,res,next)=>{if(!supportsCredit(req)){res.status(409).json({error:'Référence v5 requise.'});return;}next();},prototypeCommercialCreditRoutes(pool,secret));
 if(options.allowCreditProtocol===true)r.post('/remote-sale-edits/abandon',async(req,res,next)=>{try{
  if(!supportsCredit(req)){res.status(409).json({error:'Référence v5 requise.'});return;}
  const result=await abandonRemoteSalePrototype(pool,req.body,{secret,token:bearer(req.get('Authorization'))});res.json(result);
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
 r.get('/day/:day/details',async(req,res,next)=>{try{const actor=await verifyCommercialSession(pool,secret,bearer(req.get('Authorization')));if(!actor){res.status(401).json({error:'Session invalide ou expirée.'});return;}const {closureEvents:_adminHistory,...details}=supportsCredit(req)?await readPrototypeCreditJournal(pool,actor.id,req.params.day):await readIdentifiedJournalDay(pool,actor.id,req.params.day,enforceMode);res.json(details);}catch(e){errorHandler(e,res,next);}});
 r.get('/day/:day',async(req,res,next)=>{try{const actor=await verifyCommercialSession(pool,secret,bearer(req.get('Authorization')));if(!actor){res.status(401).json({error:'Session invalide ou expirée.'});return;}if(enforceMode)assertIdentifiedMode(await readSyncMode(pool));res.json(await readTourClosure(pool,actor.id,req.params.day));}catch(e){errorHandler(e,res,next);}});
 r.post('/close',async(req,res,next)=>{try{const data=input.parse(req.body);const result=await requestTourTransition(pool,data,{kind:'commercial',secret,token:bearer(req.get('Authorization'))},enforceMode,supportsCredit(req));res.status(result.status==='received'?201:200).json(result);}catch(e){errorHandler(e,res,next);}});
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
 // Reste désactivé dans server.ts. L'authentification est imposée par ce
 // routeur parent, avant même de vérifier la version ou de traiter la requête.
 if(options.allowCreditProtocol===true)r.use('/credit-notes',(req,res,next)=>{if(req.get('X-SLS-Reference-Version')!=='5'){res.status(409).json({error:'Référence v5 requise.'});return;}next();},prototypeAdminCreditRoutes(pool,(_req,_res,next)=>next(),adminName));
 r.post('/:commercialId/reopen',async(req,res,next)=>{try{const data=input.parse(req.body);const result=await requestTourTransition(pool,data,{kind:'admin',actorId:adminName,commercialId:req.params.commercialId},enforceMode,options.allowCreditProtocol===true&&req.get('X-SLS-Reference-Version')==='5');res.status(result.status==='received'?201:200).json(result);}catch(e){errorHandler(e,res,next);}});
 return r;
}
