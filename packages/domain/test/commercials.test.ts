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
