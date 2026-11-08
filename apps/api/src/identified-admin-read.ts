/** Lecture admin uniquement : données de l'espace expérimental, sans action de clôture. */
import {Router} from 'express';
import {ZodError} from 'zod';
import type {Pool} from 'pg';
import {readIdentifiedJournalDay} from './identified-journal-day.js';
import {readJournalPaymentHistory} from './journal-payment-history.js';
export function identifiedAdminReadRoutes(pool:Pool) {
 const r=Router();
 r.get('/:commercialId/:day/payments',async(req,res,next)=>{
  try {const data=await readJournalPaymentHistory(pool,req.params.commercialId,req.params.day);res.set('Cache-Control','no-store').json(data);}
  catch(error){if(error instanceof ZodError){res.status(400).json({error:'Commercial ou date invalide.'});return;}if(error instanceof RangeError && error.message==='Commercial introuvable.'){res.status(404).json({error:error.message});return;}next(error);}
 });
 r.get('/:commercialId/:day',async(req,res,next)=>{
  try {
   const day=await readIdentifiedJournalDay(pool,req.params.commercialId,req.params.day);
   res.set('Cache-Control','no-store').json(day);
  } catch(error) {
   if(error instanceof ZodError){res.status(400).json({error:'Commercial ou date invalide.'});return;}
   if(error instanceof RangeError && error.message==='Commercial introuvable.'){res.status(404).json({error:error.message});return;}
   next(error);
  }
 });
 return r;
}
