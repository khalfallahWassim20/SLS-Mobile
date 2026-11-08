import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial} from '../../../apps/api/src/commercials.js';
import {changeTourClosure,readTourClosure} from '../../../apps/api/src/tour-closure-store.js';

test('clôture persistée, réouverture admin, versions et audit atomiques',async()=>{
 const db=new PGlite();
 try {
  await db.exec(schemaSql);await db.exec(schemaSql);
  const client={query:(sql:string,params?:unknown[])=>db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>client,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  const commercial=await saveCommercial(pool,'admin',{name:'Fictif',active:true});
  const actor={id:commercial.id,role:'commercial' as const},admin={id:'admin',role:'admin' as const};
  const day='2026-11-08';
  assert.equal((await readTourClosure(pool,commercial.id,day)).version,0);
  assert.equal((await changeTourClosure(pool,commercial.id,day,'close',actor,0)).status,'closed');
  await assert.rejects(changeTourClosure(pool,commercial.id,day,'reopen',actor,1),/administrateur/);
  await assert.rejects(changeTourClosure(pool,commercial.id,day,'reopen',admin,0),/Version/);
  assert.equal((await readTourClosure(pool,commercial.id,day)).status,'closed');
  const failing={query:async(sql:string,params?:unknown[])=>{if(sql.includes('INSERT INTO tour_closure_events'))throw Error('audit indisponible');return db.query(sql,params);},release:()=>{}};
  await assert.rejects(changeTourClosure({connect:async()=>failing} as unknown as Pool,commercial.id,day,'reopen',admin,1),/audit indisponible/);
  assert.equal((await readTourClosure(pool,commercial.id,day)).status,'closed');
  assert.equal((await changeTourClosure(pool,commercial.id,day,'reopen',admin,1)).version,2);
  const events=await db.query('SELECT action,actor_role,version FROM tour_closure_events ORDER BY version');
  assert.deepEqual(events.rows,[{action:'close',actor_role:'commercial',version:1},{action:'reopen',actor_role:'admin',version:2}]);
  assert.equal((await readTourClosure(pool,commercial.id,'2026-11-09')).status,'open');
 } finally {await db.close();}
});
