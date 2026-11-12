import {parse} from 'csv-parse/sync';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';

export type ImportArticle={barcode:string;name:string;purchaseHt:number;purchaseTtc:number;saleTtc:number};
// L'arrondi est effectué au millime à chaque étape, sans nombres flottants.
const rounded=(n:bigint,d:bigint)=>Number((n+d/2n)/d);
export function parseArticleExport(data:Buffer){
 const text=new TextDecoder('utf-8',{fatal:true}).decode(data).replace(/^\uFEFF/,'');
 const rows:string[][]=parse(text,{relax_column_count:false,skip_empty_lines:false});
 const header=rows.findIndex(r=>r[0]?.trim()==='Code a barre'&&r[1]?.trim()==='Libellé'&&r[2]?.trim()==='P.AU Htva');
 if(header<0||rows[header].length!==7)throw Error('En-tête du fichier articles non reconnu.');
 const articles:ImportArticle[]=[],seen=new Set<string>();let excluded=0;
 for(let i=header+1;i<rows.length;i++){
  const row=rows[i];if(row.length!==7)throw Error(`Ligne CSV ${i+1} invalide.`);
  if(row.every(x=>!x.trim()))continue;
  if(row.slice(3).some(x=>x.trim()))throw Error(`Colonnes supplémentaires non vides à la ligne ${i+1}.`);
  const barcode=row[0].trim(),name=row[1].replace(/\s+/g,' ').trim(),price=row[2].trim();
  if((barcode==='Commentaire'&&name==='Commentaire'&&price==='0.000 dt')||(!barcode&&name==='USING FOR LABELS'&&price==='0.000 dt')){excluded++;continue;}
  if(!name||name.length>200||barcode.length>100||/[\u0000-\u001f\u007f]/.test(barcode+name))throw Error(`Article invalide à la ligne ${i+1}.`);
  const match=/^((?:\d{1,3}(?:,\d{3})+|\d+))\.(\d{3})\s+dt$/i.exec(price);
  if(!match)throw Error(`Prix HT invalide à la ligne ${i+1}.`);
  const ht=BigInt(match[1].replaceAll(',',''))*1000n+BigInt(match[2]);
  if(ht<=0n||ht>BigInt(Number.MAX_SAFE_INTEGER)/2n)throw Error(`Prix HT hors limites à la ligne ${i+1}.`);
  const key=barcode.toLocaleLowerCase('en-US');if(barcode&&seen.has(key))throw Error(`Code-barres répété à la ligne ${i+1}.`);if(barcode)seen.add(key);
  const purchaseTtc=rounded(ht*119n,100n),saleTtc=rounded(BigInt(purchaseTtc)*120n,100n);
  articles.push({barcode,name,purchaseHt:Number(ht),purchaseTtc,saleTtc});
 }
 if(!articles.length)throw Error('Aucun article à importer.');
 return {articles,excluded,hash:createHash('sha256').update(data).digest('hex')};
}
/** Import atomique et rejouable. Pas de mise à jour automatique de fiches existantes. */
export async function importArticles(pool:Pool,source:ReturnType<typeof parseArticleExport>){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['sls-article-import-v1']);
  await db.query('LOCK TABLE articles IN SHARE ROW EXCLUSIVE MODE');
  await db.query(`CREATE TABLE IF NOT EXISTS article_import_batches (source_hash text PRIMARY KEY, article_count integer NOT NULL, imported_at timestamptz NOT NULL DEFAULT now())`);
  const prior=await db.query('SELECT article_count FROM article_import_batches WHERE source_hash=$1',[source.hash]);
  if(prior.rows.length){if(prior.rows[0].article_count!==source.articles.length)throw Error('Import précédent incohérent.');await db.query('COMMIT');return {status:'already-imported' as const,count:source.articles.length};}
  const barcodes=source.articles.map(a=>a.barcode.toLocaleLowerCase('en-US')).filter(Boolean);
  const clashes=await db.query(`SELECT barcode FROM articles WHERE barcode<>'' AND lower(barcode)=ANY($1::text[]) LIMIT 1`,[barcodes]);
  if(clashes.rows.length)throw Error('Un code-barres existe déjà : import annulé, vérifiez les fiches existantes.');
  for(const a of source.articles){
   const id=randomUUID();
   await db.query(`INSERT INTO articles(id,code,barcode,name,purchase_ttc,sale_ttc,vat_rate,units_per_carton,active) VALUES($1,'ART-' || lpad(nextval('article_code_seq')::text,6,'0'),$2,$3,$4,$5,1900,1,true)`,[id,a.barcode,a.name,a.purchaseTtc,a.saleTtc]);
   await db.query(`INSERT INTO audit_log(id,actor,action,entity,entity_id,entity_name,changed_fields) VALUES($1,'import CSV administrateur','import','articles',$2,$3,$4)`,[randomUUID(),id,a.name,['barcode','name','purchaseTtc','saleTtc','vatRate','unitsPerCarton','active']]);
  }
  await db.query('INSERT INTO article_import_batches(source_hash,article_count) VALUES($1,$2)',[source.hash,source.articles.length]);
  await db.query('COMMIT');return {status:'imported' as const,count:source.articles.length};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
