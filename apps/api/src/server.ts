import 'dotenv/config';
import express, { type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z, ZodError } from 'zod';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pool } from './db.js';

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
// Mode de démonstration explicitement activé avec un jeton distinct de l'admin.
// Ne jamais exposer ni utiliser avec de vraies données sans HTTPS et comptes commerciaux.
app.get('/api/mobile/reference', rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res) => {
  const expected = process.env.MOBILE_DEMO_TOKEN;
  const supplied = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
  const a = Buffer.from(expected ?? ''), b = Buffer.from(supplied);
  if (!expected || expected.length < 32 || a.length !== b.length || !timingSafeEqual(a, b)) { res.status(401).json({ error: 'Accès mobile refusé.' }); return; }
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const clients = await db.query(`SELECT id,name,sector FROM clients WHERE active AND deleted_at IS NULL ORDER BY name`);
    // Projection explicite : pas de prix d'achat ni d'autres champs confidentiels.
    const articles = await db.query(`SELECT id,code,barcode,name,sale_ttc::text AS "saleTtc",vat_rate AS "vatRate",units_per_carton AS "unitsPerCarton" FROM articles WHERE active AND deleted_at IS NULL ORDER BY name`);
    await db.query('COMMIT');
    res.set('Cache-Control','no-store').json({ version: 1, clients: clients.rows, articles: articles.rows });
  } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
});
app.use('/api', auth);
const text = (max: number) => z.string().trim().max(max);
const clientSchema = z.object({ name: text(200).min(1), sector: text(100), address: text(300), taxId: text(100), phone: text(50), openingBalance: z.number().int().safe(), creditLimit: z.number().int().safe().min(0), active: z.boolean() }).strict();
const articleSchema = z.object({ name: text(200).min(1), barcode: text(100), purchaseTtc: z.number().int().safe().min(0), saleTtc: z.number().int().safe().min(0), vatRate: z.number().int().min(0).max(10000), unitsPerCarton: z.number().int().min(1).max(1000000), active: z.boolean() }).strict();
const uuid = z.string().uuid();
const clientFields = `id,name,sector,address,tax_id AS "taxId",phone,opening_balance::text AS "openingBalance",credit_limit::text AS "creditLimit",active`;
const articleFields = `id,code,barcode,name,purchase_ttc::text AS "purchaseTtc",sale_ttc::text AS "saleTtc",vat_rate AS "vatRate",units_per_carton AS "unitsPerCarton",active`;
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
