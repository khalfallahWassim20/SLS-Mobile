import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import jwt from 'jsonwebtoken';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial,verifyCommercialSession,nextTunisMidnight} from '../../../apps/api/src/commercial-session.js';

test('session commerciale isolée : connexion, rôle, expiration et révocation',async()=>{
 const db=new PGlite(),secret='secret de test suffisamment long pour signature';
 try {
  await db.exec(schemaSql);await db.exec(schemaSql);
  const client={query:(sql:string,params?:unknown[])=>db.query(sql,params),release:()=>{}};
  const pool={connect:async()=>client,query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as Pool;
  const c=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});
  await setCommercialCredentials(pool,'admin',c.id,{login:'demo.un',password:'mot de passe fictif'});
  assert.equal(await loginCommercial(pool,secret,{login:'absent',password:'mot de passe fictif'}),null);
  assert.equal(await loginCommercial(pool,secret,{login:'demo.un',password:'incorrect'}),null);
  assert.equal(await loginCommercial(pool,secret,{login:'demo.un',password:'é'.repeat(40)}),null);
  const session=await loginCommercial(pool,secret,{login:' DEMO.UN ',password:'mot de passe fictif'});
  assert.ok(session);assert.equal(session.commercial.id,c.id);
  const claims=jwt.decode(session.token) as jwt.JwtPayload;assert.equal((claims.exp ?? 0)*1000,Date.parse(session.expiresAt));assert.ok(Date.parse(session.expiresAt)>Date.now());
  assert.deepEqual(await verifyCommercialSession(pool,secret,session.token),{id:c.id,name:'Commercial fictif'});
  assert.equal(await verifyCommercialSession(pool,secret,session.token+'x'),null);
  const admin=jwt.sign({role:'admin',version:'1'},secret,{subject:c.id,audience:'sls-commercial-demo',expiresIn:'1h'});
  assert.equal(await verifyCommercialSession(pool,secret,admin),null);
  const expired=jwt.sign({role:'commercial',version:'1'},secret,{subject:c.id,audience:'sls-commercial-demo',expiresIn:-1});
  assert.equal(await verifyCommercialSession(pool,secret,expired),null);
  // Ancien jeton encore techniquement valide mais émis un jour tunisien antérieur.
  const oldIat=Math.floor(Date.now()/1000)-48*3600;
  const old=jwt.sign({role:'commercial',version:'1',iat:oldIat,exp:oldIat+72*3600},secret,{subject:c.id,audience:'sls-commercial-demo'});
  assert.equal(await verifyCommercialSession(pool,secret,old),null);
  await setCommercialCredentials(pool,'admin',c.id,{login:'demo.un',password:'nouveau mot de passe'});
  assert.equal(await verifyCommercialSession(pool,secret,session.token),null);
  const next=await loginCommercial(pool,secret,{login:'demo.un',password:'nouveau mot de passe'});assert.ok(next);
  await saveCommercial(pool,'admin',{name:'Commercial fictif',active:false},c.id);
  assert.equal(await verifyCommercialSession(pool,secret,next.token),null);
  assert.equal(await loginCommercial(pool,secret,{login:'demo.un',password:'nouveau mot de passe'}),null);
  await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true},c.id);
  assert.equal(await verifyCommercialSession(pool,secret,next.token),null);
 } finally {await db.close();}
});

test('expiration à minuit en Tunisie, y compris après changement de jour et fin d’année',()=>{
 for(const [input,expected] of [['2026-11-08T09:00:00.000Z','2026-11-08T23:00:00.000Z'],['2026-11-08T22:59:59.999Z','2026-11-08T23:00:00.000Z'],['2026-11-08T23:00:00.000Z','2026-11-09T23:00:00.000Z'],['2026-12-31T23:00:00.000Z','2027-01-01T23:00:00.000Z']])assert.equal(nextTunisMidnight(new Date(input)).toISOString(),expected);
});
