/** Tests PostgreSQL isolés : aucune route v5 active dans l'application. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale} from '../src/identified-operations.js';
import {storePrototypeCreditNote} from '../src/credit-note-registry-prototype.js';
import {previewAdminCredit,assertAdminCreditReview} from '../src/credit-note-admin-review-prototype.js';
async function waitBlocked(pool:pg.Pool,pid:number){const end=Date.now()+5000;while(Date.now()<end){const r=await pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid]);if(r.rows[0].n)return;await new Promise(r=>setTimeout(r,25));}throw Error('Verrou non observé.');}
test('PostgreSQL : aperçu admin refusé après modification concurrente du solde',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_admin_review_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});
  await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const c=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true}),secret='secret fictif assez long pour les tests';
  await setCommercialCredentials(pool,'admin',c.id,{login:'review.test',password:'mot de passe fictif'});const session=await loginCommercial(pool,secret,{login:'review.test',password:'mot de passe fictif'});assert.ok(session);
  const clientId=randomUUID(),saleId=randomUUID(),at=new Date().toISOString();await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,1000000)',[clientId,'Client fictif']);
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},{secret,token:session.token,enforceMode:true,creditAware:true});
  const command={operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:at,choice:'refund' as const},input={clientId,kind:'sale' as const,command};
  const preview=await previewAdminCredit(pool,input);assert.equal(preview.balanceBefore,1069000);
  const lock=await pool.connect();
  try{
   await lock.query('BEGIN');await lock.query('UPDATE clients SET opening_balance=opening_balance+1000 WHERE id=$1',[clientId]);
   const pending=storePrototypeCreditNote(pool,command,{kind:'admin',actorId:'admin'},(db,cmd,id)=>assertAdminCreditReview(db,cmd,id,'sale',preview)).then(value=>({value,error:null as unknown}),error=>({value:null,error}));
   await waitBlocked(pool,lock.processID);await lock.query('COMMIT');
   const result=await pending;assert.match(String(result.error),/Facture ou solde modifié/);assert.equal((await pool.query('SELECT count(*)::int AS n FROM credit_note_prototype_events')).rows[0].n,0);
   const latest=await previewAdminCredit(pool,input);assert.equal(latest.balanceBefore,1070000);assert.equal((await storePrototypeCreditNote(pool,command,{kind:'admin',actorId:'admin'},(db,cmd,id)=>assertAdminCreditReview(db,cmd,id,'sale',latest))).status,'received');
  }finally{await lock.query('ROLLBACK').catch(()=>{});lock.release();}
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
