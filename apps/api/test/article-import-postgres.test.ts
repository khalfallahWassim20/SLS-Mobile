import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {parseArticleExport,importArticles} from '../src/article-import.js';
import {readIdentifiedReferenceInTransaction} from '../src/identified-reference.js';
const csv=(s:string)=>Buffer.from(`"Code a barre","Libellé","P.AU Htva","","","",""\n${s}`);
test('PostgreSQL : import articles atomique, idempotent, collision et prix achat exclus du mobile',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');const root=new pg.Pool({connectionString:url}),schema='sls_import_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});await pool.query(schemaSql);
  const source=parseArticleExport(csv('"X-01","Huile fictive","46.310 dt","","","",""\n"","Filtre fictif","1.000 dt","","","",""'));
  assert.deepEqual(await importArticles(pool,source),{status:'imported',count:2});assert.deepEqual(await importArticles(pool,source),{status:'already-imported',count:2});
  const rows=await pool.query('SELECT code,barcode,purchase_ttc::text,sale_ttc::text,vat_rate,units_per_carton FROM articles ORDER BY barcode DESC');
  assert.equal(rows.rowCount,2);assert.equal(rows.rows[0].purchase_ttc,'55109');assert.equal(rows.rows[0].sale_ttc,'66131');assert.equal(rows.rows[1].barcode,'');assert.match(rows.rows[1].code,/^ART-/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n,2);
  await assert.rejects(importArticles(pool,parseArticleExport(csv('"x-01","Collision","1.000 dt","","","",""\n"NOUVEAU","Autre","1.000 dt","","","",""'))),/existe déjà/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM articles')).rows[0].n,2);
  const db=await pool.connect();try{await db.query('BEGIN');const ref=await readIdentifiedReferenceInTransaction(db,true);assert.equal(ref.articles.length,2);assert.ok(ref.articles.every(a=>!('purchaseTtc' in a)&&!('purchase_ttc' in a)));await db.query('ROLLBACK');}finally{db.release();}
 }finally{if(pool)await pool.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
