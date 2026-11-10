/** Lecture admin uniquement : données de l'espace expérimental, sans action de clôture. */
import {Router} from 'express';
import {ZodError} from 'zod';
import type {Pool} from 'pg';
import {readIdentifiedJournalDay} from './identified-journal-day.js';
import {readJournalPaymentHistory} from './journal-payment-history.js';
import {CreditProtocolUpgradeRequired} from './credit-note-active-guards.js';
import {readPrototypeCreditJournal} from './credit-note-journal-prototype.js';
import {readPrototypeAdminCreditSnapshot,readPrototypeAdminCreditSaleHistory} from './credit-note-admin-snapshot-prototype.js';
export function identifiedAdminReadRoutes(pool:Pool,options:{allowCreditProtocol?:boolean}={}) {
 const r=Router();
 // Route v5 isolée, toujours derrière l'authentification de l'appelant.
 if(options.allowCreditProtocol===true)r.get('/credit-snapshot',async(req,res,next)=>{
  if(req.get('X-SLS-Reference-Version')!=='5'){res.status(409).json({error:'Référence v5 requise.'});return;}
  try{res.set('Cache-Control','no-store').json(await readPrototypeAdminCreditSnapshot(pool));}catch(error){next(error);}
 });
 if(options.allowCreditProtocol===true)r.get('/credit-sales/:saleId/history',async(req,res,next)=>{
  if(req.get('X-SLS-Reference-Version')!=='5'){res.status(409).json({error:'Référence v5 requise.'});return;}
  try{const history=await readPrototypeAdminCreditSaleHistory(pool,req.params.saleId);if(!history){res.status(404).json({error:'Vente introuvable.'});return;}res.set('Cache-Control','no-store').json(history);}
  catch(error){if(error instanceof ZodError){res.status(400).json({error:'Identifiant de vente invalide.'});return;}next(error);}
 });
 r.get('/:commercialId/:day/payments',async(req,res,next)=>{
  try {const data=await readJournalPaymentHistory(pool,req.params.commercialId,req.params.day);res.set('Cache-Control','no-store').json(data);}
  catch(error){if(error instanceof ZodError){res.status(400).json({error:'Commercial ou date invalide.'});return;}if(error instanceof RangeError && error.message==='Commercial introuvable.'){res.status(404).json({error:error.message});return;}next(error);}
 });
 r.get('/:commercialId/:day',async(req,res,next)=>{
  try {
   const day=options.allowCreditProtocol===true&&req.get('X-SLS-Reference-Version')==='5'?await readPrototypeCreditJournal(pool,req.params.commercialId,req.params.day):await readIdentifiedJournalDay(pool,req.params.commercialId,req.params.day);
   res.set('Cache-Control','no-store').json(day);
  } catch(error) {
   if(error instanceof CreditProtocolUpgradeRequired){res.status(409).json({error:error.message,code:'CREDIT_PROTOCOL_UPGRADE_REQUIRED'});return;}
   if(error instanceof ZodError){res.status(400).json({error:'Commercial ou date invalide.'});return;}
   if(error instanceof RangeError && error.message==='Commercial introuvable.'){res.status(404).json({error:error.message});return;}
   next(error);
  }
 });
 return r;
}
