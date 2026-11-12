import {matchingCashProof} from '../../../packages/domain/test/cash-close-fixture.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale} from '../src/identified-operations.js';
import {storePrototypeCreditNote} from '../src/credit-note-registry-prototype.js';
import {assignAdminCreditRefund} from '../src/credit-refund-assignment-prototype.js';
import {requestTourTransition,abandonTourClose} from '../src/tour-closure-store.js';
import {readPrototypeCreditJournal} from '../src/credit-note-journal-prototype.js';

test('PostgreSQL : attribution concurrente, reprise et protection de caisse',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');const root=new pg.Pool({connectionString:url}),schema='sls_assign_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const a=await saveCommercial(pool,'admin',{name:'Commercial A',active:true}),b=await saveCommercial(pool,'admin',{name:'Commercial B',active:true}),owner=await saveCommercial(pool,'admin',{name:'Propriétaire C',active:true});
  await setCommercialCredentials(pool,'admin',a.id,{login:'assign.a',password:'mot de passe fictif'});await setCommercialCredentials(pool,'admin',b.id,{login:'assign.b',password:'mot de passe fictif'});await setCommercialCredentials(pool,'admin',owner.id,{login:'assign.owner',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour les tests',sa=await loginCommercial(pool,secret,{login:'assign.a',password:'mot de passe fictif'}),sb=await loginCommercial(pool,secret,{login:'assign.b',password:'mot de passe fictif'}),so=await loginCommercial(pool,secret,{login:'assign.owner',password:'mot de passe fictif'});assert.ok(sa&&sb&&so);
  const auth={secret,token:so.token,enforceMode:true,creditAware:true};
  for(let i=1;i<=6;i++){
   const day=`2026-07-0${i}`,at=`${day}T09:00:00.000Z`,clientId=randomUUID(),saleId=randomUUID();await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Fictif']);
   const sale={createdAt:at,clientId,clientName:'Fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Huile',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
   await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},auth);
   const command={operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:`${day}T10:00:00.000Z`,choice:'refund' as const};await storePrototypeCreditNote(pool,command,{kind:'admin',actorId:'admin'});
   const left={requestId:randomUUID(),noteOperationId:command.operationId,refund:50000,commercialId:a.id},right={...left,requestId:randomUUID(),commercialId:b.id};
   const outcomes=await Promise.allSettled([assignAdminCreditRefund(pool,left,'admin'),assignAdminCreditRefund(pool,right,'admin')]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
   const winner=outcomes[0].status==='fulfilled'?left:right,loser=winner===left?right:left;assert.equal((await assignAdminCreditRefund(pool,winner,'admin')).status,'duplicate');await assert.rejects(assignAdminCreditRefund(pool,loser,'admin'),/déjà/);
   // Même lorsque la sortie a été attribuée à une autre caisse, le propriétaire
   // ne peut pas clôturer tant que son téléphone ne projette pas cet avoir.
   await assert.rejects(requestTourTransition(pool,{requestId:randomUUID(),day,expectedVersion:0,adminRefundProof:[],cashProof:await matchingCashProof(pool,owner.id,day)},{kind:'commercial',secret,token:so.token},true,true),/rapprochement du facturé/);
   const report=await readPrototypeCreditJournal(pool,winner.commercialId,day);assert.equal(report.creditRefundTotal,50000);assert.equal(report.creditCashEvents[0].cashAssignment?.requestId,winner.requestId);
   const token=winner.commercialId===a.id?sa.token:sb.token;await assert.rejects(requestTourTransition(pool,{requestId:randomUUID(),day,expectedVersion:0},{kind:'commercial',secret,token},true,true),/rapprochement du téléphone/);
   const principal={kind:'commercial' as const,secret,token};
   const proof=[{noteOperationId:command.operationId,assignmentId:winner.requestId,refund:50000}];
   const close={requestId:randomUUID(),day,expectedVersion:0,adminRefundProof:proof,cashProof:await matchingCashProof(pool,winner.commercialId,day)};
   const abandon={requestId:close.requestId,day,expectedVersion:0};
   // Course entre demande envoyée et abandon : une seule issue, jamais
   // une clôture suivie d'un abandon qui permettrait de la perdre.
   const [transition,discard]=await Promise.allSettled([requestTourTransition(pool,close,principal,true,true),abandonTourClose(pool,abandon,principal)]);
   assert.equal(discard.status,'fulfilled');if(discard.status!=='fulfilled')throw Error('Abandon échoué');
   if(discard.value.status==='already-received'){
    assert.equal(transition.status,'fulfilled');assert.equal((await requestTourTransition(pool,close,principal,true,true)).status,'duplicate');
   }else{
    assert.equal(transition.status,'rejected');await assert.rejects(requestTourTransition(pool,close,principal,true,true),/abandonnée/);
    assert.equal((await abandonTourClose(pool,abandon,principal)).status,'abandoned');
    assert.equal((await requestTourTransition(pool,{...close,requestId:randomUUID()},principal,true,true)).status,'received');
   }
   const other=winner.commercialId===a.id?sb.token:sa.token,otherId=winner.commercialId===a.id?b.id:a.id;assert.equal((await requestTourTransition(pool,{requestId:randomUUID(),day,expectedVersion:0,cashProof:await matchingCashProof(pool,otherId,day)},{kind:'commercial',secret,token:other},true,true)).status,'received');
  }
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});

test('PostgreSQL : clôture concurrente à un nouvel avoir administrateur et preuve périmée',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');const root=new pg.Pool({connectionString:url}),schema='sls_proof_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const a=await saveCommercial(pool,'admin',{name:'A',active:true}),b=await saveCommercial(pool,'admin',{name:'B',active:true});await setCommercialCredentials(pool,'admin',a.id,{login:'race.owner',password:'mot de passe fictif'});await setCommercialCredentials(pool,'admin',b.id,{login:'race.actor',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour les tests',sa=await loginCommercial(pool,secret,{login:'race.owner',password:'mot de passe fictif'}),sb=await loginCommercial(pool,secret,{login:'race.actor',password:'mot de passe fictif'});assert.ok(sa&&sb);
  for(let i=1;i<=8;i++){
   const day=`2026-08-0${i}`,at=`${day}T09:00:00.000Z`,clientId=randomUUID(),saleId=randomUUID();await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Fictif']);
   const sale={createdAt:at,clientId,clientName:'Fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Huile',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
   await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},{secret,token:sa.token,enforceMode:true,creditAware:true});
   const command={operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:`${day}T10:00:00.000Z`,choice:'refund' as const},principal={kind:'commercial' as const,secret,token:sb.token};
   const close={requestId:randomUUID(),day,expectedVersion:0,adminRefundProof:[],cashProof:await matchingCashProof(pool,b.id,day)};
   const [credit,closed]=await Promise.allSettled([storePrototypeCreditNote(pool,command,{kind:'admin',actorId:'admin'}),requestTourTransition(pool,close,principal,true,true)]);
   assert.notEqual(credit.status,closed.status,'une seule transaction doit réussir');
   if(credit.status==='fulfilled'){
    assert.equal(closed.status,'rejected');const assignment={requestId:randomUUID(),noteOperationId:command.operationId,refund:50000,commercialId:b.id};await assignAdminCreditRefund(pool,assignment,'admin');
    await assert.rejects(requestTourTransition(pool,close,principal,true,true),/rapprochement du téléphone/);
    const proof=[{noteOperationId:command.operationId,assignmentId:assignment.requestId,refund:50000}];
    assert.equal((await requestTourTransition(pool,{...close,requestId:randomUUID(),adminRefundProof:proof,cashProof:await matchingCashProof(pool,b.id,day)},principal,true,true)).status,'received');
   }else assert.equal(closed.status,'fulfilled');
  }
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
