import 'dotenv/config';
import express, { type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z, ZodError } from 'zod';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { pool } from './db.js';
import { calculateInvoice } from '@sls/domain';
import { experimentalJournalRoutes } from './journal-routes.js';
import { readJournalReference } from './journal-reference.js';
import { readServerJournalDay } from './journal-day.js';
import { JournalConflict, storeJournalSnapshot } from './journal-store.js';
import { listCommercials, saveCommercial, setCommercialCredentials } from './commercials.js';
import { loginCommercial, verifyCommercialSession } from './commercial-session.js';
import { identifiedAdminReadRoutes } from './identified-admin-read.js';

const { JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD_HASH } = process.env;
if (!JWT_SECRET || JWT_SECRET.length < 32 || !ADMIN_USERNAME || !ADMIN_PASSWORD_HASH || !/^\$2[aby]\$/.test(ADMIN_PASSWORD_HASH)) throw new Error('Configurer JWT_SECRET (32 caractères minimum), ADMIN_USERNAME et ADMIN_PASSWORD_HASH dans apps/api/.env');
const secret: string = JWT_SECRET, username: string = ADMIN_USERNAME, passwordHash: string = ADMIN_PASSWORD_HASH;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.post('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res) => {
  const input = z.object({ username: z.string().max(200), password: z.string().max(200) }).safeParse(req.body);
  if (!input.success || input.data.username !== username || !(await bcrypt.compare(input.data.password, passwordHash))) { res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' }); return; }
  res.json({ token: jwt.sign({ role: 'admin' }, secret, { subject: username, expiresIn: '1h', algorithm: 'HS256' }) });
});
const auth: RequestHandler = (req, res, next) => {
  try { const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]; if (!token) throw new Error(); const claims = jwt.verify(token, secret, { algorithms: ['HS256'] }); if (typeof claims !== 'object' || claims.role !== 'admin' || claims.sub !== username) throw new Error(); next(); }
  catch { res.status(401).json({ error: 'Session invalide ou expirée.' }); }
};
// Connexion isolée pour essais : ces sessions ne donnent pas encore accès aux données mobiles.
app.post('/api/mobile/session/login', rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:'draft-8',legacyHeaders:false}), async (req,res) => {
 const session=await loginCommercial(pool,secret,req.body);
 res.set('Cache-Control','no-store');
 if (!session) {res.status(401).json({error:'Identifiant ou mot de passe incorrect.'});return;}
 res.json(session);
});
app.get('/api/mobile/session', rateLimit({windowMs:15*60*1000,limit:100,standardHeaders:'draft-8',legacyHeaders:false}), async (req,res) => {
 const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
 const commercial=await verifyCommercialSession(pool,secret,token);
 res.set('Cache-Control','no-store');
 if (!commercial) {res.status(401).json({error:'Session invalide ou expirée.'});return;}
 res.json({commercial});
});
// Une fois des journaux reçus, la référence v2 ne doit jamais masquer leur effet.
async function journalSyncActive() {
  if (process.env.MOBILE_JOURNAL_SYNC === '1') return true;
  const result=await pool.query('SELECT EXISTS (SELECT 1 FROM sync_journal_events) AS active');
  return result.rows[0].active === true;
}
// Mode de démonstration explicitement activé avec un jeton distinct de l'admin.
// Ne jamais exposer ni utiliser avec de vraies données sans HTTPS et comptes commerciaux.
app.get('/api/mobile/reference', rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res) => {
  const expected = process.env.MOBILE_DEMO_TOKEN;
  const supplied = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
  const a = Buffer.from(expected ?? ''), b = Buffer.from(supplied);
  if (!expected || expected.length < 32 || a.length !== b.length || !timingSafeEqual(a, b)) { res.status(401).json({ error: 'Accès mobile refusé.' }); return; }
  if (await journalSyncActive()) { res.set('Cache-Control','no-store').json(await readJournalReference(pool)); return; }
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const clients = await db.query(`WITH latest AS (
      SELECT DISTINCT ON (sale_id) client_id,payload FROM demo_sale_events ORDER BY sale_id,version DESC
    ), sales AS (
      SELECT client_id,sum((payload->'sale'->>'total')::bigint-(payload->'sale'->>'paid')::bigint) AS balance FROM latest GROUP BY client_id
    ), payments AS (
      SELECT client_id,sum((payload->'settlement'->>'amount')::bigint) AS total FROM demo_settlements GROUP BY client_id
    ) SELECT c.id,c.name,c.sector,c.opening_balance::text AS "openingBalance",c.credit_limit::text AS "creditLimit",
      (c.opening_balance + COALESCE(s.balance,0) - COALESCE(p.total,0))::text AS "serverBalance"
      FROM clients c LEFT JOIN sales s ON s.client_id=c.id LEFT JOIN payments p ON p.client_id=c.id
      WHERE c.active AND c.deleted_at IS NULL ORDER BY c.name`);
    // Ces marqueurs permettent au mobile de ne pas recompter ses propres opérations.
    const saleStates = await db.query(`SELECT DISTINCT ON (e.sale_id) e.sale_id AS "saleId",e.client_id AS "clientId",e.version,
      e.payload->'sale'->>'total' AS total,e.payload->'sale'->>'paid' AS paid
      FROM demo_sale_events e JOIN clients c ON c.id=e.client_id WHERE c.active AND c.deleted_at IS NULL ORDER BY e.sale_id,e.version DESC`);
    const settlementStates = await db.query(`SELECT p.operation_id AS "operationId",p.client_id AS "clientId"
      FROM demo_settlements p JOIN clients c ON c.id=p.client_id WHERE c.active AND c.deleted_at IS NULL`);
    // Projection explicite : pas de prix d'achat ni d'autres champs confidentiels.
    const articles = await db.query(`SELECT id,code,barcode,name,sale_ttc::text AS "saleTtc",vat_rate AS "vatRate",units_per_carton AS "unitsPerCarton" FROM articles WHERE active AND deleted_at IS NULL ORDER BY name`);
    await db.query('COMMIT');
    res.set('Cache-Control','no-store').json({ version: 2, clients: clients.rows, articles: articles.rows, saleStates: saleStates.rows, settlementStates: settlementStates.rows });
  } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
});
// Protocole de démonstration : chaque version est immuable et idempotente.
const demoSaleSchema = z.object({
  createdAt: z.string().datetime(), clientId: z.string().uuid(), clientName: z.string().min(1).max(200),
  syncSaleId: z.string().uuid(), syncVersion: z.number().int().min(1).max(1000000),
  lines: z.array(z.object({ name:z.string().min(1).max(200),code:z.string().min(1).max(100),quantity:z.number().int().min(1).max(1000000),unitPrice:z.number().int().safe().min(0),discount:z.number().int().min(0).max(10000),vat:z.number().int().min(0).max(10000) }).strict()).min(1).max(200),
  total:z.number().int().safe().min(0), paid:z.number().int().safe().min(0), remaining:z.number().int().safe().min(0),
  paymentMode:z.enum(['Espèces','Chèque','Virement','Crédit']), chequeNumber:z.string().max(100),chequeBank:z.string().max(100),chequeDue:z.string().max(100)
}).strict();
const demoEventSchema = z.object({ operationId:z.string().uuid(),saleId:z.string().uuid(),version:z.number().int().min(1).max(1000000),sale:demoSaleSchema,refund:z.number().int().safe().min(0) }).strict();
app.post('/api/mobile/sales', rateLimit({windowMs: 15 * 60 * 1000, limit: 500, standardHeaders:'draft-8', legacyHeaders:false}), async (req, res) => {
  const expected = process.env.MOBILE_DEMO_TOKEN, supplied = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
  const a = Buffer.from(expected ?? ''), b = Buffer.from(supplied);
  if (!expected || expected.length < 32 || a.length !== b.length || !timingSafeEqual(a,b)) { res.status(401).json({error:'Accès mobile refusé.'}); return; }
  if (await journalSyncActive() && req.get('X-SLS-Reference-Version') !== '3') {res.status(409).json({error:'Mettez à jour l’application et téléchargez la référence v3.'});return;}
  const event = demoEventSchema.parse(req.body);
  if (event.saleId !== event.sale.syncSaleId || event.version !== event.sale.syncVersion) {res.status(400).json({error:'Identifiants de vente incohérents.'}); return;}
  const totals = calculateInvoice(event.sale.lines.map(l => ({quantity:l.quantity,unitPrice:l.unitPrice,discountRate:l.discount,vatRate:l.vat})));
  if (totals.total !== event.sale.total || event.sale.remaining !== Math.max(0, event.sale.total - event.sale.paid) || (event.version === 1 && (event.refund !== 0 || event.sale.paid > event.sale.total))) {res.status(400).json({error:'Totaux de vente incohérents.'}); return;}
  const payload = JSON.stringify(event), hash = createHash('sha256').update(payload).digest('hex');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [event.saleId]);
    const same = await db.query('SELECT payload_hash FROM demo_sale_events WHERE operation_id=$1', [event.operationId]);
    if (same.rows.length) { await db.query('ROLLBACK'); if(same.rows[0].payload_hash !== hash) {res.status(409).json({error:'Opération déjà utilisée avec des données différentes.'});return;} res.json({status:'déjà reçue'}); return; }
    const last = await db.query('SELECT version,payload FROM demo_sale_events WHERE sale_id=$1 ORDER BY version DESC LIMIT 1', [event.saleId]);
    if ((last.rows[0]?.version ?? 0) + 1 !== event.version) { await db.query('ROLLBACK'); res.status(409).json({error:'Version de vente manquante ou déjà utilisée.'}); return; }
    if (last.rows.length) { const old = last.rows[0].payload.sale; if (old.clientId !== event.sale.clientId || old.createdAt !== event.sale.createdAt || event.sale.paid !== old.paid - event.refund || event.refund > Math.max(0, old.paid - event.sale.total)) { await db.query('ROLLBACK'); res.status(400).json({error:'Modification ou remboursement incohérent.'}); return; } }
    const client = await db.query('SELECT id FROM clients WHERE id=$1', [event.sale.clientId]);
    if (!client.rows.length) { await db.query('ROLLBACK'); res.status(400).json({error:'Client introuvable sur le serveur.'}); return; }
    await db.query('INSERT INTO demo_sale_events(operation_id,sale_id,version,client_id,payload,payload_hash) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [event.operationId,event.saleId,event.version,event.sale.clientId,payload,hash]);
    await db.query('COMMIT'); res.status(201).json({status:'reçue'});
  } catch(error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
});
// Règlement global de démonstration ; aucun transfert d'argent réel.
const settlementSchema = z.object({operationId:z.string().uuid(),settlement:z.object({syncOperationId:z.string().uuid(),createdAt:z.string().datetime(),clientId:z.string().uuid(),clientName:z.string().trim().min(1).max(200),amount:z.number().int().safe().positive(),mode:z.enum(['Espèces','Chèque','Virement']),chequeNumber:z.string().max(100),chequeBank:z.string().max(100),chequeDue:z.string().max(100)}).strict()}).strict();
app.post('/api/mobile/settlements', rateLimit({windowMs: 15*60*1000,limit:500,standardHeaders:'draft-8',legacyHeaders:false}), async (req,res) => {
  const expected=process.env.MOBILE_DEMO_TOKEN, supplied=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
  const a=Buffer.from(expected ?? ''), b=Buffer.from(supplied);
  if(!expected || expected.length<32 || a.length!==b.length || !timingSafeEqual(a,b)) {res.status(401).json({error:'Accès mobile refusé.'});return;}
  if (await journalSyncActive() && req.get('X-SLS-Reference-Version') !== '3') {res.status(409).json({error:'Mettez à jour l’application et téléchargez la référence v3.'});return;}
  const event=settlementSchema.parse(req.body), p=event.settlement;
  if(event.operationId!==p.syncOperationId || (p.mode==='Chèque' && (!p.chequeNumber.trim() || !p.chequeBank.trim() || !p.chequeDue.trim()))) {res.status(400).json({error:'Règlement incohérent.'});return;}
  const data=JSON.stringify(event), hash=createHash('sha256').update(data).digest('hex'), db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[event.operationId]);
    const existing=await db.query('SELECT payload_hash FROM demo_settlements WHERE operation_id=$1',[event.operationId]);
    if(existing.rows.length) {await db.query('ROLLBACK'); if(existing.rows[0].payload_hash!==hash) {res.status(409).json({error:'Opération déjà utilisée avec des données différentes.'});return;} res.json({status:'déjà reçue'});return;}
    if(!(await db.query('SELECT id FROM clients WHERE id=$1',[p.clientId])).rows.length) {await db.query('ROLLBACK');res.status(400).json({error:'Client introuvable sur le serveur.'});return;}
    await db.query('INSERT INTO demo_settlements(operation_id,client_id,payload,payload_hash) VALUES($1,$2,$3::jsonb,$4)',[event.operationId,p.clientId,data,hash]);
    await db.query('COMMIT');res.status(201).json({status:'reçue'});
  } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
});
// Démonstration uniquement : ne pas activer avant validation des tests PostgreSQL et multi-appareils.
app.post('/api/mobile/journal', rateLimit({windowMs:15*60*1000,limit:500,standardHeaders:'draft-8',legacyHeaders:false}), async (req,res,next) => {
  const expected=process.env.MOBILE_DEMO_TOKEN, supplied=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
  const a=Buffer.from(expected ?? ''),b=Buffer.from(supplied);
  if (!expected || expected.length<32 || a.length!==b.length || !timingSafeEqual(a,b)) {res.status(401).json({error:'Accès mobile refusé.'});return;}
  try {
    if (!(await journalSyncActive())) {res.status(404).json({error:'Synchronisation du journal non activée.'});return;}
    if (req.get('X-SLS-Reference-Version') !== '3') {res.status(409).json({error:'Téléchargez la référence v3 avant l’envoi.'});return;}
    const status=await storeJournalSnapshot(pool,req.body,'sync');
    res.status(status==='received'?201:200).json({status,operationId:req.body.operationId});
  } catch(error) {
    if(error instanceof JournalConflict) {res.status(409).json({error:error.message});return;}
    if(error instanceof ZodError || error instanceof RangeError) {res.status(400).json({error:'Données de journal invalides.'});return;}
    next(error);
  }
});
app.use('/api', auth);
// Vue admin en lecture seule : l'espace expérimental ne reflète pas le journal mobile actuel.
app.use('/api/identified-tour', identifiedAdminReadRoutes(pool));
// Endpoint réservé aux essais administrateur : désactivé par défaut, hors soldes et hors synchronisation mobile.
app.use('/api/experimental/journal', experimentalJournalRoutes(pool, process.env.JOURNAL_EXPERIMENTAL === '1'));
const text = (max: number) => z.string().trim().max(max);
const clientSchema = z.object({ name: text(200).min(1), sector: text(100), address: text(300), taxId: text(100), phone: text(50), openingBalance: z.number().int().safe(), creditLimit: z.number().int().safe().min(0), active: z.boolean() }).strict();
const articleSchema = z.object({ name: text(200).min(1), barcode: text(100), purchaseTtc: z.number().int().safe().min(0), saleTtc: z.number().int().safe().min(0), vatRate: z.number().int().min(0).max(10000), unitsPerCarton: z.number().int().min(1).max(1000000), active: z.boolean() }).strict();
const uuid = z.string().uuid();
const clientFields = `id,name,sector,address,tax_id AS "taxId",phone,opening_balance::text AS "openingBalance",credit_limit::text AS "creditLimit",active`;
const articleFields = `id,code,barcode,name,purchase_ttc::text AS "purchaseTtc",sale_ttc::text AS "saleTtc",vat_rate AS "vatRate",units_per_carton AS "unitsPerCarton",active`;
// Réservé à l'admin ; les fiches ne donnent pas encore accès au mobile.
// La configuration prépare les comptes, sans encore autoriser la connexion mobile.
app.put('/api/commercials/:id/credentials', async (req,res) => {
 try {
  const saved=await setCommercialCredentials(pool,username,req.params.id,req.body);
  if (!saved) {res.status(404).json({error:'Commercial introuvable.'});return;}
  res.set('Cache-Control','no-store').json(saved);
 } catch(error) {
  if (typeof error==='object' && error !== null && 'code' in error && error.code==='23505') {res.status(409).json({error:'Cet identifiant est déjà utilisé.'});return;}
  throw error;
 }
});
app.get('/api/commercials', async (_req,res) => {res.json(await listCommercials(pool));});
app.post('/api/commercials', async (req,res) => {const saved=await saveCommercial(pool,username,req.body);res.status(201).json(saved);});
app.put('/api/commercials/:id', async (req,res) => {const saved=await saveCommercial(pool,username,req.body,req.params.id);if(!saved) {res.status(404).json({error:'Commercial introuvable.'});return;}res.json(saved);});
app.get('/api/clients', async (_req, res) => { const r = await pool.query(`SELECT ${clientFields} FROM clients WHERE deleted_at IS NULL ORDER BY name LIMIT 10000`); res.json(r.rows); });
app.get('/api/articles', async (_req, res) => { const r = await pool.query(`SELECT ${articleFields} FROM articles WHERE deleted_at IS NULL ORDER BY name LIMIT 10000`); res.json(r.rows); });
// La mutation et son journal sont validés ensemble ou annulés ensemble.
async function changeWithAudit(entity: 'clients' | 'articles', action: 'création' | 'modification', id: string, query: string, values: unknown[], fields: string) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const before = action === 'modification' ? (await db.query(`SELECT ${fields} FROM ${entity} WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0] : null;
    if (action === 'modification' && !before) { await db.query('ROLLBACK'); return null; }
    const result = await db.query(query, values);
    const after = result.rows[0];
    if (!after) { await db.query('ROLLBACK'); return null; }
    const changed = before ? Object.keys(after).filter(key => key !== 'id' && String(after[key]) !== String(before[key])) : [];
    await db.query(`INSERT INTO audit_log(id,actor,action,entity,entity_id,entity_name,changed_fields) VALUES($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), username, action, entity, id, after.name, changed]);
    await db.query('COMMIT');
    return after;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
app.get('/api/demo-balances', async (_req,res) => {
 const reference=await readJournalReference(pool,true);
 res.json(reference.clients.map(c=>({id:c.id,name:c.name,openingBalance:c.openingBalance,creditLimit:c.creditLimit,balance:c.serverBalance})));
});
app.get('/api/demo-tour-journal/:date', async (req,res) => {
 const result=await readServerJournalDay(pool,req.params.date,'sync');
 res.set('Cache-Control','no-store').json(result);
});
app.get('/api/demo-settlements', async (_req,res) => {
 const r=await pool.query(`SELECT operation_id AS "operationId",payload->'settlement' AS settlement,received_at AS "receivedAt" FROM demo_settlements ORDER BY received_at DESC LIMIT 1000`); res.json(r.rows);
});
app.get('/api/demo-sales', async (_req, res) => {
 const r = await pool.query(`SELECT DISTINCT ON (sale_id) sale_id AS "saleId",version,payload->'sale' AS sale,received_at AS "receivedAt" FROM demo_sale_events ORDER BY sale_id,version DESC`);
 res.json(r.rows);
});
app.get('/api/overview', async (_req, res) => {
  const r = await pool.query(`SELECT
    (SELECT count(*) FROM clients WHERE deleted_at IS NULL) AS clients,
    (SELECT count(*) FROM clients WHERE deleted_at IS NULL AND active) AS active_clients,
    (SELECT count(*) FROM articles WHERE deleted_at IS NULL) AS articles,
    (SELECT count(*) FROM articles WHERE deleted_at IS NULL AND active) AS active_articles`);
  res.json(r.rows[0]);
});
app.get('/api/audit', async (_req, res) => {
  const r = await pool.query(`SELECT id,actor,action,entity,entity_id AS "entityId",entity_name AS "entityName",changed_fields AS "changedFields",created_at AS "createdAt" FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 200`);
  res.json(r.rows);
});
app.post('/api/clients', async (req, res) => { const c = clientSchema.parse(req.body), id = randomUUID(); const r = await changeWithAudit('clients','création',id,`INSERT INTO clients(id,name,sector,address,tax_id,phone,opening_balance,credit_limit,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${clientFields}`, [id,c.name,c.sector,c.address,c.taxId,c.phone,c.openingBalance,c.creditLimit,c.active],clientFields); res.status(201).json(r); });
app.put('/api/clients/:id', async (req, res) => { const id = uuid.parse(req.params.id), c = clientSchema.parse(req.body); const r = await changeWithAudit('clients','modification',id,`UPDATE clients SET name=$2,sector=$3,address=$4,tax_id=$5,phone=$6,opening_balance=$7,credit_limit=$8,active=$9,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING ${clientFields}`, [id,c.name,c.sector,c.address,c.taxId,c.phone,c.openingBalance,c.creditLimit,c.active],clientFields); if (!r) { res.status(404).json({error:'Client introuvable.'}); return; } res.json(r); });
app.post('/api/articles', async (req, res) => { const a = articleSchema.parse(req.body), id = randomUUID(); const r = await changeWithAudit('articles','création',id,`INSERT INTO articles(id,code,name,barcode,purchase_ttc,sale_ttc,vat_rate,units_per_carton,active) VALUES($1,'ART-' || lpad(nextval('article_code_seq')::text, 6, '0'),$2,$3,$4,$5,$6,$7,$8) RETURNING ${articleFields}`, [id,a.name,a.barcode,a.purchaseTtc,a.saleTtc,a.vatRate,a.unitsPerCarton,a.active],articleFields); res.status(201).json(r); });
app.put('/api/articles/:id', async (req, res) => { const id = uuid.parse(req.params.id), a = articleSchema.parse(req.body); const r = await changeWithAudit('articles','modification',id,`UPDATE articles SET name=$2,barcode=$3,purchase_ttc=$4,sale_ttc=$5,vat_rate=$6,units_per_carton=$7,active=$8,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING ${articleFields}`, [id,a.name,a.barcode,a.purchaseTtc,a.saleTtc,a.vatRate,a.unitsPerCarton,a.active],articleFields); if (!r) { res.status(404).json({error:'Article introuvable.'}); return; } res.json(r); });
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { if (err instanceof ZodError) { res.status(400).json({error:'Données invalides.', details: err.flatten()}); return; } console.error(err); res.status(500).json({error:'Erreur serveur.'}); });
app.listen(Number(process.env.PORT || 3001), process.env.API_HOST || '127.0.0.1', () => console.log('API de développement prête sur le port ' + (process.env.PORT || 3001)));
