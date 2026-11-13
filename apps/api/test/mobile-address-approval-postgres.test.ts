/** Schéma aléatoire uniquement ; ne jamais utiliser une base réelle pour ce test. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {issueAddressApproval,redeemAddressApproval,revokeAddressApproval} from '../src/mobile-address-approval.js';
test('PostgreSQL : autorisation concurrente et reprise sans double audit',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');const root=new pg.Pool({connectionString:url}),schema='sls_address_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:5});await pool.query(schemaSql);
  const person=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});assert.ok(person);await setCommercialCredentials(pool,'admin',person.id,{login:'commercial.test',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour les tests',session=await loginCommercial(pool,secret,{login:'commercial.test',password:'mot de passe fictif'});assert.ok(session);
  const lineageId=(await pool.query('SELECT lineage_id::text AS id FROM server_lineage_identity')).rows[0].id;
  const input={requestId:randomUUID(),commercialId:person.id,previousOrigin:'http://192.168.43.101:3001',targetOrigin:'https://api.example.test',lineageId};
  const approvals=await Promise.allSettled([1,2].map(()=>issueAddressApproval(pool!,'admin',{...input,confirmation:'J_AI_VERIFIE_LA_BASE_ET_LE_TELEPHONE'})));
  assert.equal(approvals.filter(x=>x.status==='fulfilled').length,1);const selected=approvals.find(x=>x.status==='fulfilled');assert.ok(selected&&selected.status==='fulfilled');
  const body={...input,code:selected.value.code};
  const results=await Promise.all([redeemAddressApproval(pool,secret,session.token,body),redeemAddressApproval(pool,secret,session.token,body)]);
  assert.deepEqual(results.map(r=>r.replay).sort(),[false,true]);
  const counts=await pool.query("SELECT action,count(*)::int AS n FROM audit_log WHERE entity_id=$1 GROUP BY action",[input.requestId]);assert.deepEqual(new Map(counts.rows.map(r=>[r.action,r.n])),new Map([['autorisation changement adresse',1],['autorisation présentée',1]]));
  await revokeAddressApproval(pool,'admin',input.requestId);await assert.rejects(redeemAddressApproval(pool,secret,session.token,body),/Autorisation/);
 }finally{if(pool)await pool.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
