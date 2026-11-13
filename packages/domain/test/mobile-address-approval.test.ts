import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {issueAddressApproval,redeemAddressApproval,revokeAddressApproval} from '../../../apps/api/src/mobile-address-approval.js';

test('autorisation de changement : audit, session, expiration, révocation et reprise',async()=>{
 const db=new PGlite();try{
  await db.exec(schemaSql);const client={query:(sql:string,args?:unknown[])=>db.query(sql,args),release:()=>{}};const pool={query:client.query,connect:async()=>client} as unknown as Pool;
  const admin='admin test',secret='secret fictif assez long pour les tests';
  const person=await saveCommercial(pool,admin,{name:'Commercial test',active:true});assert.ok(person);
  await setCommercialCredentials(pool,admin,person.id,{login:'commercial.test',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'commercial.test',password:'mot de passe fictif'});assert.ok(session);
  const lineage=(await db.query<{id:string}>('SELECT lineage_id::text AS id FROM server_lineage_identity')).rows[0].id;
  const input={requestId:randomUUID(),commercialId:person.id,previousOrigin:'http://192.168.43.101:3001',targetOrigin:'https://api.example.test',lineageId:lineage};
  const make=(data= input)=>issueAddressApproval(pool,admin,{...data,confirmation:'J_AI_VERIFIE_LA_BASE_ET_LE_TELEPHONE'});
  await assert.rejects(make({...input,targetOrigin:'http://api.example.test'}));
  await assert.rejects(make({...input,lineageId:randomUUID()}),/Autorisation/);
  await assert.rejects(issueAddressApproval(pool,admin,{...input,confirmation:'oui'}));
  const issued=await make();assert.equal(issued.code.length,43);assert.equal(issued.requestId,input.requestId);
  const row=(await db.query<{code_hash:string}>('SELECT code_hash FROM mobile_address_approvals')).rows[0];assert.notEqual(row.code_hash,issued.code);assert.equal(row.code_hash.length,64);
  await assert.rejects(make(),/Autorisation/);
  const redeem=(data=input,code=issued.code,token=session.token)=>redeemAddressApproval(pool,secret,token,{...data,code});
  await assert.rejects(redeem(input,issued.code,'incorrect'),/Autorisation/);
  await assert.rejects(redeem(input,'A'.repeat(43)),/Autorisation/);
  await assert.rejects(redeem({...input,targetOrigin:'https://else.example'}),/Autorisation/);
  const result=await redeem();assert.equal(result.replay,false);assert.equal(result.lineageId,lineage);
  assert.equal((await redeem()).replay,true);
  const audits=await db.query<{action:string}>('SELECT action FROM audit_log WHERE entity_id=$1 ORDER BY created_at',[input.requestId]);assert.deepEqual(audits.rows.map(r=>r.action),['autorisation changement adresse','autorisation présentée']);
  assert.deepEqual(await revokeAddressApproval(pool,admin,input.requestId),{revoked:true});assert.deepEqual(await revokeAddressApproval(pool,admin,input.requestId),{revoked:false});
  await assert.rejects(redeem(),/Autorisation/);
  const second={...input,requestId:randomUUID()},expired=await make(second);
  await db.query("UPDATE mobile_address_approvals SET created_at=now()-interval '10 minutes',expires_at=now()-interval '1 minute' WHERE request_id=$1",[second.requestId]);
  await assert.rejects(redeemAddressApproval(pool,secret,session.token,{...second,code:expired.code}),/Autorisation/);
  const third={...input,requestId:randomUUID()},last=await make(third);
  await setCommercialCredentials(pool,admin,person.id,{login:'commercial.test',password:'nouveau mot de passe'});
  await assert.rejects(redeemAddressApproval(pool,secret,session.token,{...third,code:last.code}),/Autorisation/);
 }finally{await db.close();}
});

test('routes préparatoires : refus HTTP, authentification admin et commercial, interdiction cache',async()=>{
 const express=(await import('express')).default;const {addressApprovalAdminRoutes,addressApprovalCommercialRoutes}=await import('../../../apps/api/src/mobile-address-approval-routes.js');
 const db=new PGlite();let server:ReturnType<ReturnType<typeof express>['listen']>|undefined;try{
  await db.exec(schemaSql);const client={query:(sql:string,args?:unknown[])=>db.query(sql,args),release:()=>{}};const pool={query:client.query,connect:async()=>client} as unknown as Pool;
  const person=await saveCommercial(pool,'admin',{name:'Test routes',active:true});assert.ok(person);await setCommercialCredentials(pool,'admin',person.id,{login:'routes.test',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour les tests',session=await loginCommercial(pool,secret,{login:'routes.test',password:'mot de passe fictif'});assert.ok(session);
  const lineageId=(await db.query<{id:string}>('SELECT lineage_id::text AS id FROM server_lineage_identity')).rows[0].id;
  const app=express();app.use(express.json());
  // Le test simule seulement le transport sécurisé après avoir vérifié que le
  // HTTP réel est refusé ; ne teste pas la configuration d'un proxy TLS.
  app.use('/http',addressApprovalAdminRoutes(pool,(_q,_s,n)=>n(),'admin'));
  app.use('/secure',(req,_res,next)=>{Object.defineProperty(req,'secure',{value:true});next();});
  app.use('/secure/admin',addressApprovalAdminRoutes(pool,(req,res,next)=>{if(req.get('Authorization')!=='Bearer admin-test')res.sendStatus(401);else next();},'admin'));
  app.use('/secure/mobile',addressApprovalCommercialRoutes(pool,secret));
  server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');const root=`http://127.0.0.1:${address.port}`;
  const input={requestId:randomUUID(),commercialId:person.id,previousOrigin:'http://192.168.43.101:3001',targetOrigin:'https://api.example.test',lineageId};
  const post=(url:string,data:unknown,token?:string)=>fetch(root+url,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(data)});
  assert.equal((await post('/http/',{})).status,403);
  const body={...input,confirmation:'J_AI_VERIFIE_LA_BASE_ET_LE_TELEPHONE'};assert.equal((await post('/secure/admin/',body)).status,401);
  const issue=await post('/secure/admin/',body,'admin-test');assert.equal(issue.status,201);assert.match(issue.headers.get('cache-control')??'',/no-store/);
  const {code}=await issue.json() as {code:string};assert.equal((await post('/secure/mobile/redeem',{...input,code},'invalid')).status,409);
  const redeemed=await post('/secure/mobile/redeem',{...input,code},session.token);assert.equal(redeemed.status,200);assert.equal((await redeemed.json() as {requestId:string}).requestId,input.requestId);
  assert.equal((await post(`/secure/admin/${input.requestId}/revoke`,{},'admin-test')).status,200);assert.equal((await post('/secure/mobile/redeem',{...input,code},session.token)).status,409);
 }finally{if(server)await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve()));await db.close();}
});
