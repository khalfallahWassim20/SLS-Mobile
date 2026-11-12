import 'dotenv/config';
import {readFile} from 'node:fs/promises';
import {parseArticleExport,importArticles} from './article-import.js';
const args=process.argv.slice(2),path=args[0],apply=args[1]==='IMPORTER_LES_ARTICLES';
if(!path||args.length>2||(args[1]&&!apply)){console.error('Usage : npm run import:articles -- <fichier.csv> [IMPORTER_LES_ARTICLES]');process.exitCode=1;}
else try{
 const parsed=parseArticleExport(await readFile(path));
 console.log(`${parsed.articles.length} articles ; ${parsed.excluded} lignes techniques exclues ; ${parsed.articles.filter(a=>!a.barcode).length} sans code-barres.`);
 console.log('Achat TTC = achat HT × 1,19, arrondi au millime ; vente TTC = achat TTC × 1,20, arrondi au millime. TVA 19 %, quantité par carton provisoire : 1.');
 if(!apply)console.log('Aperçu uniquement : aucune écriture.');
 else {
  if(!process.env.DATABASE_URL)throw Error('DATABASE_URL doit être définie explicitement pour sélectionner la base.');
  const {Pool}=await import('pg');const pool=new Pool({connectionString:process.env.DATABASE_URL});
  try{const result=await importArticles(pool,parsed);console.log(result.status==='imported'?`${result.count} articles importés.`:'Ce fichier a déjà été importé ; aucune nouvelle écriture.');}finally{await pool.end();}
 }
}catch(e){console.error(e instanceof Error?e.message:'Import impossible.');process.exitCode=1;}
