import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,listCommercials,commercialCanViewPurchasePrice} from '../../../apps/api/src/commercials.js';
import {readIdentifiedReference} from '../../../apps/api/src/identified-reference.js';

const article={id:'a',code:'ART-000007',barcode:'',name:'ACEM POMPE A GRAISSE MANUELLE 12L',saleTtc:'280255',vatRate:1900,unitsPerCarton:12};

test('référence mobile : le prix d’achat est facultatif, validé et conservé tel quel',async()=>{
 const {validateReference}=await import('../../../apps/mobile/reference.js');
 const base={version:1,clients:[],articles:[article]};
 const without=validateReference(base);
 assert.equal('purchaseTtc' in without.articles[0],false);
 assert.equal(without.articles[0].unitsPerCarton,12);
 assert.equal(validateReference({...base,articles:[{...article,purchaseTtc:'238000'}]}).articles[0].purchaseTtc,'238000');
 for(const bad of ['-1','abc','1.5',100000,null,'9007199254740993'])
  assert.throws(()=>validateReference({...base,articles:[{...article,purchaseTtc:bad}]}),/Article invalide|Prix d.achat invalide/);
});

test('référence individuelle v4 : le prix d’achat survit à la validation',async()=>{
 const {validateIdentifiedReference}=await import('../../../apps/mobile/identified-reference.js');
 const value={version:4,clients:[{id:'client',name:'Fictif',sector:'',openingBalance:'0',creditLimit:'0',serverBalance:'0'}],articles:[{...article,purchaseTtc:'59500'}],saleStates:[],settlementStates:[],journalStates:[{id:'facture',clientId:'client',journalDate:'2026-11-10',total:1000,receipts:[]}],journalProofs:[{id:'facture',version:1,hash:'a'.repeat(64)}]};
 assert.equal(validateIdentifiedReference(value).articles[0].purchaseTtc,'59500');
 assert.equal('purchaseTtc' in validateIdentifiedReference({...value,articles:[article]}).articles[0],false);
});

test('marge unitaire : montants en millimes, taux en centièmes de pour cent',async()=>{
 const {unitMargin}=await import('../../../apps/mobile/reference.js');
 assert.deepEqual(unitMargin('119000','59500',1900),{amount:50000,rate:5000});
 assert.deepEqual(unitMargin('119000','238000',1900),{amount:-100000,rate:-10000});
 assert.deepEqual(unitMargin('0','119000',1900),{amount:-100000,rate:0});
});

test('fiche article : rien du prix d’achat ne fuit tant qu’il n’est pas affiché',async()=>{
 const {describeArticle}=await import('../../../apps/mobile/article-detail.js');
 const plain=describeArticle(article,false);
 assert.equal(plain.purchase,null);
 const labels=Object.fromEntries(plain.rows.map(r=>[r.label,r.value]));
 assert.equal(labels['Référence'],'ART-000007');
 assert.equal(labels['Code-barres'],'\u2014');
 assert.equal(labels['TVA'],'19 %');
 assert.equal(labels['Prix de vente TTC / unité'],'280,255 DT');
 assert.equal(labels['Prix de vente HT / unité'],'235,508 DT');
 assert.equal(labels['Quantité par carton'],'12');
 assert.equal(labels['Prix du carton TTC'],'3363,060 DT');
 assert.equal('Prix du carton TTC' in Object.fromEntries(describeArticle({...article,unitsPerCarton:1},false).rows.map(r=>[r.label,r.value])),false);
 assert.equal(describeArticle({...article,vatRate:550},false).rows.find(r=>r.label==='TVA')?.value,'5,5 %');
 // Droit présent mais prix masqué : un bouton peut s’afficher, mais aucun montant ne doit figurer.
 const sale={...article,saleTtc:'119000',purchaseTtc:'59500'};
 const hidden=describeArticle(sale,false);
 assert.deepEqual(hidden.purchase,{revealed:false,rows:[]});
 assert.equal(JSON.stringify(hidden).includes('59,500'),false);
 assert.equal(JSON.stringify(hidden).includes('59500'),false);
 // Affiché : prix d’achat et marge.
 const shown=describeArticle(sale,true).purchase!;
 assert.deepEqual(shown.rows.map(r=>r.value),['59,500 DT','50,000 DT','50,00 %']);
 // Vente à perte : montants négatifs signalés.
 const loss=describeArticle({...sale,purchaseTtc:'238000'},true).purchase!;
 assert.deepEqual(loss.rows.map(r=>r.value),['238,000 DT','\u2212 100,000 DT','\u2212 100,00 %']);
 assert.deepEqual(loss.rows.map(r=>!!r.negative),[false,true,true]);
});

test('droit aux prix d’achat : refusé par défaut, audité, révoque la session, limité aux commerciaux actifs',async()=>{
 const db=new PGlite();
 try {
  await db.exec(schemaSql);await db.exec(schemaSql);
  const client={query:(sql:string,params?:unknown[])=>db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>client,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  const created=await saveCommercial(pool,'admin',{name:'Ali',active:true});
  const version=async()=>((await db.query('SELECT session_version::text AS v FROM commercial_credentials WHERE commercial_id=$1',[created.id])).rows[0] as {v:string}).v;
  assert.equal(await commercialCanViewPurchasePrice(pool,created.id),false);
  assert.equal((await listCommercials(pool))[0].canViewPurchasePrice,false);
  await db.query("INSERT INTO commercial_credentials(commercial_id,login,password_hash) VALUES($1,'ali','hash')",[created.id]);
  // Accord explicite : session révoquée, changement tracé dans l’audit.
  await saveCommercial(pool,'admin',{name:'Ali',active:true,canViewPurchasePrice:true},created.id);
  assert.equal(await commercialCanViewPurchasePrice(pool,created.id),true);
  assert.equal(await version(),'2');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE 'canViewPurchasePrice' = ANY(changed_fields)")).rows[0].n as number,1);
  assert.equal((await listCommercials(pool))[0].canViewPurchasePrice,true);
  // Un enregistrement sans le champ ne modifie ni le droit ni la session.
  await saveCommercial(pool,'admin',{name:'Ali 2',active:true},created.id);
  assert.equal(await commercialCanViewPurchasePrice(pool,created.id),true);
  assert.equal(await version(),'2');
  // Retrait du droit.
  await saveCommercial(pool,'admin',{name:'Ali 2',active:true,canViewPurchasePrice:false},created.id);
  assert.equal(await commercialCanViewPurchasePrice(pool,created.id),false);
  assert.equal(await version(),'3');
  // Un commercial désactivé ou inconnu n’a jamais accès, même avec le droit enregistré.
  await saveCommercial(pool,'admin',{name:'Ali 2',active:true,canViewPurchasePrice:true},created.id);
  await saveCommercial(pool,'admin',{name:'Ali 2',active:false},created.id);
  assert.equal(await commercialCanViewPurchasePrice(pool,created.id),false);
  assert.equal(await commercialCanViewPurchasePrice(pool,'00000000-0000-4000-8000-000000000999'),false);
 } finally {await db.close();}
});

test('référence serveur : prix d’achat exclu par défaut, inclus seulement sur demande expresse',async()=>{
 const db=new PGlite();
 try {
  await db.exec(schemaSql);await db.exec(schemaSql);
  const conn={query:(sql:string,params?:unknown[])=>db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>conn,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  await db.query('INSERT INTO articles(id,code,name,purchase_ttc,sale_ttc,units_per_carton) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),'ART-1','Article fictif',59500,119000,12]);
  const hidden=await readIdentifiedReference(pool);
  assert.equal('purchaseTtc' in hidden.articles[0],false);
  assert.equal('purchase_ttc' in hidden.articles[0],false);
  assert.equal(hidden.articles[0].unitsPerCarton,12);
  const shown=await readIdentifiedReference(pool,false,false,true);
  assert.equal(shown.articles[0].purchaseTtc,'59500');
  assert.equal(shown.articles[0].saleTtc,'119000');
  assert.equal('purchase_ttc' in shown.articles[0],false);
 } finally {await db.close();}
});
