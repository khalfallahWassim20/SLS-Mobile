/** Routeurs pour tests isolés uniquement : ne pas monter dans server.ts.
 * Les registres expérimentaux n'alimentent pas les soldes de l'application. */
import {Router,type RequestHandler,type NextFunction,type Response} from 'express';
import {ZodError} from 'zod';
import type {Pool} from 'pg';
import {JournalAuthenticationError,JournalConflict,TourDayClosed} from './journal-store.js';
import {IdentifiedOverlap} from './identified-overlap.js';
import {IdentifiedSyncDisabled} from './tour-sync-mode.js';
import {storePrototypeCreditNote} from './credit-note-registry-prototype.js';
import {storePrototypePreInvoiceCredit} from './pre-invoice-credit-registry-prototype.js';

type Principal={kind:'commercial';secret:string;token:string}|{kind:'admin';actorId:string};
function fail(error:unknown,res:Response,next:NextFunction) {
 if(error instanceof JournalAuthenticationError){res.status(401).json({error:'Session invalide ou expirée.'});return;}
 if(error instanceof TourDayClosed){res.status(409).json({error:error.message,code:'TOUR_DAY_CLOSED',day:error.day,commercialId:error.commercialId});return;}
 if(error instanceof JournalConflict||error instanceof IdentifiedOverlap||error instanceof IdentifiedSyncDisabled){res.status(409).json({error:error.message});return;}
 if(error instanceof ZodError||error instanceof RangeError){res.status(400).json({error:'Données invalides.'});return;}
 next(error);
}
function routes(pool:Pool,principal:(req:import('express').Request)=>Principal) {
 const r=Router();r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 for(const kind of ['sales','preinvoices'] as const)r.post('/'+kind,async(req,res,next)=>{
  try {
   const result=kind==='sales'?await storePrototypeCreditNote(pool,req.body,principal(req)):await storePrototypePreInvoiceCredit(pool,req.body,principal(req));
   res.status(result.status==='received'?201:200).json({status:result.status,operationId:req.body.operationId});
  }catch(error){fail(error,res,next);}
 });
 return r;
}
export function prototypeCommercialCreditRoutes(pool:Pool,secret:string) {
 return routes(pool,req=>({kind:'commercial',secret,token:req.get('Authorization')?.match(/^Bearer (.+)$/)?.[1]??''}));
}
/** Le middleware et le nom doivent provenir de la configuration serveur fiable. */
export function prototypeAdminCreditRoutes(pool:Pool,authenticateAdmin:RequestHandler,adminName:string) {
 const r=Router();r.use(authenticateAdmin);r.use(routes(pool,()=>({kind:'admin',actorId:adminName})));return r;
}
