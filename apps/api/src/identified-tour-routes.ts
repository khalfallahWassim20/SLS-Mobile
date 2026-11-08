/** Routeurs isolés pour tests, non montés sur le serveur de l'application. */
import {Router,type RequestHandler} from 'express';
import {rateLimit} from 'express-rate-limit';
import {ZodError,z} from 'zod';
import type {Pool} from 'pg';
import {verifyCommercialSession} from './commercial-session.js';
import {ClosureAuthenticationError,ClosureConflict,readTourClosure,requestTourTransition} from './tour-closure-store.js';
import {JournalAuthenticationError,JournalConflict,storeJournalSnapshot} from './journal-store.js';
import {storeIdentifiedSale,storeIdentifiedSettlement} from './identified-operations.js';
import {readIdentifiedReference,ReferenceOverlap} from './identified-reference.js';
import {readIdentifiedJournalDay} from './identified-journal-day.js';
import {IdentifiedOverlap} from './identified-overlap.js';
import {IdentifiedSyncDisabled,assertIdentifiedMode,readSyncMode} from './tour-sync-mode.js';

const input=z.object({requestId:z.string().uuid(),day:z.string(),expectedVersion:z.number().int().min(0)}).strict();
const bearer=(value:string|undefined)=>value?.match(/^Bearer (.+)$/)?.[1]??'';
function errorHandler(error:unknown,res:import('express').Response,next:import('express').NextFunction) {
 if(error instanceof ClosureAuthenticationError || error instanceof JournalAuthenticationError) {res.status(401).json({error:'Session invalide ou expirée.'});return;}
 if(error instanceof ClosureConflict || error instanceof JournalConflict || error instanceof ReferenceOverlap || error instanceof IdentifiedOverlap || error instanceof IdentifiedSyncDisabled) {res.status(409).json({error:error.message});return;}
 if(error instanceof ZodError || error instanceof RangeError) {res.status(400).json({error:'Données invalides.'});return;}
 next(error);
}
export function identifiedCommercialRoutes(pool:Pool,secret:string,options:{enforceMode?:boolean}={}) {
 const enforceMode=options.enforceMode!==false;
 const r=Router();r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 r.use(rateLimit({windowMs:15*60*1000,limit:500,standardHeaders:'draft-8',legacyHeaders:false}));
 r.get('/reference',async(req,res,next)=>{try{const actor=await verifyCommercialSession(pool,secret,bearer(req.get('Authorization')));if(!actor){res.status(401).json({error:'Session invalide ou expirée.'});return;}res.json(await readIdentifiedReference(pool,false,enforceMode));}catch(e){errorHandler(e,res,next);}});
 r.get('/day/:day/details',async(req,res,next)=>{try{const actor=await verifyCommercialSession(pool,secret,bearer(req.get('Authorization')));if(!actor){res.status(401).json({error:'Session invalide ou expirée.'});return;}const {closureEvents:_adminHistory,...details}=await readIdentifiedJournalDay(pool,actor.id,req.params.day,enforceMode);res.json(details);}catch(e){errorHandler(e,res,next);}});
 r.get('/day/:day',async(req,res,next)=>{try{const actor=await verifyCommercialSession(pool,secret,bearer(req.get('Authorization')));if(!actor){res.status(401).json({error:'Session invalide ou expirée.'});return;}if(enforceMode)assertIdentifiedMode(await readSyncMode(pool));res.json(await readTourClosure(pool,actor.id,req.params.day));}catch(e){errorHandler(e,res,next);}});
 r.post('/close',async(req,res,next)=>{try{const data=input.parse(req.body);const result=await requestTourTransition(pool,data,{kind:'commercial',secret,token:bearer(req.get('Authorization'))},enforceMode);res.status(result.status==='received'?201:200).json(result);}catch(e){errorHandler(e,res,next);}});
 for(const kind of ['journal','sales','settlements'] as const) r.post('/'+kind,async(req,res,next)=>{try{
  const session={secret,token:bearer(req.get('Authorization')),enforceMode};
  const status=kind==='journal'?await storeJournalSnapshot(pool,req.body,'identified',session):kind==='sales'?await storeIdentifiedSale(pool,req.body,session):await storeIdentifiedSettlement(pool,req.body,session);
  res.status(status==='received'?201:200).json({status,operationId:req.body.operationId});
 }catch(e){errorHandler(e,res,next);}});
 return r;
}
/** Le middleware admin doit vérifier réellement la session. Le nom de l'admin est configuré côté serveur. */
export function identifiedAdminRoutes(pool:Pool,authenticateAdmin:RequestHandler,adminName:string,options:{enforceMode?:boolean}={}) {
 const enforceMode=options.enforceMode!==false;
 const r=Router();r.use(authenticateAdmin);r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 r.post('/:commercialId/reopen',async(req,res,next)=>{try{const data=input.parse(req.body);const result=await requestTourTransition(pool,data,{kind:'admin',actorId:adminName,commercialId:req.params.commercialId},enforceMode);res.status(result.status==='received'?201:200).json(result);}catch(e){errorHandler(e,res,next);}});
 return r;
}
