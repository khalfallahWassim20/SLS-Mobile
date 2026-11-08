import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {commercialInputSchema,listCommercials,saveCommercial} from '../../../apps/api/src/commercials.js';

test('fiche commercial : champs stricts et nom obligatoire',()=>{
 assert.deepEqual(commercialInputSchema.parse({name:'  Commercial démo  ',active:true}),{name:'Commercial démo',active:true});
 assert.throws(()=>commercialInputSchema.parse({name:' ',active:true}));
 assert.throws(()=>commercialInputSchema.parse({name:'X',active:'true'}));
 assert.throws(()=>commercialInputSchema.parse({name:'X',active:true,password:'secret'}));
});

test('création, modification et audit dans PostgreSQL intégré',async()=>{
 const db=new PGlite();
 try {
  await db.exec(schemaSql);await db.exec(schemaSql);
  const client={query:(sql:string,params?:unknown[])=>db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>client,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  const created=await saveCommercial(pool,'admin-demo',{name:'  Ali Démo  ',active:true});
  assert.equal(created.name,'Ali Démo'); assert.equal(created.active,true);
  const edited=await saveCommercial(pool,'admin-demo',{name:'Ali Modifié',active:false},created.id);
  assert.equal(edited.id,created.id);assert.equal(edited.active,false);
  const audit=await db.query("SELECT action,entity,entity_id,changed_fields FROM audit_log WHERE entity='commercials' ORDER BY created_at");
  assert.equal(audit.rows.length,2);assert.deepEqual(audit.rows.map((r:any)=>r.action),['création','modification']);
  const last=audit.rows[1] as {entity_id:string;changed_fields:string[]};
  assert.equal(last.entity_id,created.id);assert.deepEqual(last.changed_fields,['name','active']);
  assert.equal((await listCommercials(pool)).length,1);
  assert.equal(await saveCommercial(pool,'admin-demo',{name:'X',active:true},'00000000-0000-4000-8000-000000000999'),null);
  const failing={query:async(sql:string,params?:unknown[])=>{if(sql.startsWith('INSERT INTO audit_log')) throw Error('audit indisponible');return db.query(sql,params);},release:()=>{}};
  const failPool={connect:async()=>failing} as unknown as Pool;
  await assert.rejects(saveCommercial(failPool,'admin-demo',{name:'Ne doit pas rester',active:true}),/audit indisponible/);
  assert.equal((await listCommercials(pool)).length,1);
 } finally {await db.close();}
});

test('identifiants préparatoires : hachage, unicité et audit sans mot de passe',async()=>{
 const {setCommercialCredentials,credentialsSchema}=await import('../../../apps/api/src/commercials.js');
 const bcrypt=await import('bcryptjs');
 assert.throws(()=>credentialsSchema.parse({login:'a b',password:'un mot de passe long'}));
 assert.throws(()=>credentialsSchema.parse({login:'test',password:'court'}));
 assert.throws(()=>credentialsSchema.parse({login:'test',password:'é'.repeat(40)}));
 const db=new PGlite();
 try {
  await db.exec(schemaSql); await db.exec(schemaSql);
  const client={query:(sql:string,params?:unknown[])=>db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>client,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  const one=await saveCommercial(pool,'admin',{name:'Un',active:true});
  const two=await saveCommercial(pool,'admin',{name:'Deux',active:true});
  await setCommercialCredentials(pool,'admin',one.id,{login:' Test.User ',password:'mot de passe fictif'});
  const row=(await db.query('SELECT login,password_hash FROM commercial_credentials')).rows[0] as {login:string;password_hash:string};
  assert.equal(row.login,'test.user');assert.notEqual(row.password_hash,'mot de passe fictif');assert.ok(await bcrypt.compare('mot de passe fictif',row.password_hash));
  assert.equal((await listCommercials(pool))[0].password_hash,undefined);
  await assert.rejects(setCommercialCredentials(pool,'admin',two.id,{login:'TEST.USER',password:'autre mot de passe'}));
  await setCommercialCredentials(pool,'admin',one.id,{login:'test.user',password:'nouveau mot de passe'});
  const updated=(await db.query('SELECT password_hash FROM commercial_credentials')).rows[0] as {password_hash:string};
  assert.ok(await bcrypt.compare('nouveau mot de passe',updated.password_hash));
  assert.equal(await bcrypt.compare('mot de passe fictif',updated.password_hash),false);
  const audit=JSON.stringify((await db.query('SELECT * FROM audit_log')).rows);
  assert.equal(audit.includes('mot de passe fictif'),false);assert.equal(audit.includes(updated.password_hash),false);
  assert.equal(await setCommercialCredentials(pool,'admin','00000000-0000-4000-8000-000000000999',{login:'autre',password:'mot de passe fictif'}),null);
 } finally {await db.close();}
});
