import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';
import type { Pool } from 'pg';
import { JournalConflict, storeJournalSnapshot } from './journal-store.js';
import { readServerJournalDay } from './journal-day.js';

/** Route de test administrateur, activée explicitement et isolée des soldes.
 * Elle ne doit pas servir à synchroniser les téléphones avant la version de référence suivante. */
export function experimentalJournalRoutes(pool: Pool, enabled: boolean) {
  const router = Router();
  router.use((_req,res,next) => { if (!enabled) { res.status(404).json({error:'Fonction expérimentale désactivée.'}); return; } next(); });
  router.post('/', rateLimit({windowMs:15*60*1000,limit:500,standardHeaders:'draft-8',legacyHeaders:false}), async (req,res,next) => {
    try {
      const result = await storeJournalSnapshot(pool,req.body);
      res.status(result === 'received' ? 201 : 200).json({status:result, warning:'Expérimental : non inclus dans les soldes.'});
    } catch (error) {
      if (error instanceof JournalConflict) {res.status(409).json({error:error.message}); return;}
      if (error instanceof ZodError || error instanceof RangeError) {res.status(400).json({error:'Données de journal invalides.'}); return;}
      next(error);
    }
  });
  router.get('/day/:date', async (req,res,next) => {
    try { const result=await readServerJournalDay(pool,req.params.date); res.set('Cache-Control','no-store').json({warning:'Aperçu expérimental, uniquement les opérations reçues ; les préétablis ne sont pas inclus dans les soldes serveur.',...result}); }
    catch(error) { if(error instanceof ZodError) {res.status(400).json({error:'Date invalide.'}); return;} next(error); }
  });
  router.get('/', async (_req,res,next) => {
    try {
      const result = await pool.query(`SELECT DISTINCT ON (e.invoice_id) e.invoice_id AS "invoiceId", e.version, e.payload AS snapshot, e.received_at AS "receivedAt"
        FROM demo_journal_events e ORDER BY e.invoice_id,e.version DESC`);
      res.set('Cache-Control','no-store').json({warning:'Expérimental : les opérations ci-dessous ne sont pas incluses dans les soldes.',items:result.rows});
    } catch (error) {next(error);}
  });
  return router;
}
