/** Tests réservés à une base fictive ; le registre n'est pas monté sur l'API. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import {schemaSql} from '../src/schema.js';
import {creditNotePrototypeSchema,storePrototypeCreditNote} from '../src/credit-note-registry-prototype.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale} from '../src/identified-operations.js';
import {lockIdentifiedOperation} from '../src/identified-overlap.js';

dotenv.config({path:'apps/api/.env'});
async function waitForBlocked(pool:pg.Pool,pid:number) {
 const deadline=Date.now()+5000;
 while(Date.now()<deadline) {
  const r=await pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid]);
  if(r.rows[0].n>=1)return;
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 throw Error('Aucune opération en attente');
}
test('PostgreSQL : deux demandes et deux reprises simultanées dans le registre expérimental',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const schema='sls_credit_registry_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});
 let pool:pg.Pool|undefined,created=false;
 try {
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;
  pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});
  await pool.query(schemaSql);await pool.query(creditNotePrototypeSchema);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const c=await saveCommercial(pool,'admin',{name:'Fictif',active:true}),secret='secret fictif assez long pour les tests';
  await setCommercialCredentials(pool,'admin',c.id,{login:'credit.test',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'credit.test',password:'mot de passe fictif'});assert.ok(session);
  const clientId=randomUUID(),at='2026-11-07T10:00:00.000Z',principal={kind:'commercial' as const,secret,token:session.token};
  await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Client fictif']);
  async function makeSale(){
   const invoiceId=randomUUID();const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:invoiceId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
   await storeIdentifiedSale(pool!,{operationId:randomUUID(),saleId:invoiceId,version:1,recordedAt:at,sale,refund:0},{secret,token:session!.token});
   return {operationId:randomUUID(),invoiceId,expectedVersion:1,recordedAt:'2026-11-08T10:00:00.000Z',choice:'refund' as const};
  }
  const cmd=await makeSale(),blocker=await pool.connect();
  try {
   // Les tentatives sont sérialisées par la barrière globale puis par le verrou de vente.
   await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",['identified-sale',cmd.invoiceId]);
   const attempts=Promise.allSettled([storePrototypeCreditNote(pool,cmd,principal),storePrototypeCreditNote(pool,{...cmd,operationId:randomUUID()},principal)]);
   await waitForBlocked(pool,blocker.processID);await blocker.query('COMMIT');
   const results=await attempts;assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
   const error=results.find(r=>r.status==='rejected');assert.ok(error&&error.status==='rejected');assert.match(String(error.reason),/déjà annulée/);
   const retry=await makeSale();
   await blocker.query('BEGIN');await lockIdentifiedOperation(blocker,retry.operationId);
   const replays=Promise.allSettled([storePrototypeCreditNote(pool,retry,principal),storePrototypeCreditNote(pool,retry,principal)]);
   await waitForBlocked(pool,blocker.processID);await blocker.query('COMMIT');
   const replayResults=await replays;assert.ok(replayResults.every(r=>r.status==='fulfilled'));
   const values=replayResults.map(r=>{if(r.status!=='fulfilled')throw r.reason;return r.value;});assert.deepEqual(values.map(v=>v.status).sort(),['duplicate','received']);assert.deepEqual(values[0].event,values[1].event);
   const count=await pool.query('SELECT count(*)::int AS n FROM credit_note_prototype_events');assert.equal(count.rows[0].n,2);
   const moves=await pool.query('SELECT kind, count(*)::int AS n, sum(balance_delta)::text AS total FROM credit_note_prototype_movements GROUP BY kind ORDER BY kind');
   assert.deepEqual(moves.rows,[{kind:'invoice_cancellation',n:2,total:'-238000'},{kind:'refund',n:2,total:'100000'}]);
   async function modification(command:{invoiceId:string}) {
    const row=await pool!.query('SELECT payload FROM identified_sale_events WHERE sale_id=$1 ORDER BY version DESC LIMIT 1',[command.invoiceId]);
    const first=row.rows[0].payload;
    return {first,next:{...first,operationId:randomUUID(),version:2,recordedAt:'2026-11-08T09:00:00.000Z',sale:{...first.sale,syncVersion:2}}};
   }
   const auth={secret,token:session!.token};
   // Avoir d'abord : la modification attend le verrou puis est refusée.
   const cancelled=await makeSale(),change=await modification(cancelled);
   await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",['identified-sale',cancelled.invoiceId]);
   const pendingNote=storePrototypeCreditNote(pool,cancelled,principal).then(value=>({value,error:null as unknown}),error=>({value:null,error}));
   await waitForBlocked(pool,blocker.processID);
   const pendingEdit=storeIdentifiedSale(pool,change.next,{...auth,enforceMode:false}).then(value=>({value,error:null as unknown}),error=>({value:null,error}));
   await blocker.query('COMMIT');
   assert.equal((await pendingNote).value?.status,'received');assert.match(String((await pendingEdit).error),/annulée/);
   assert.equal(await storeIdentifiedSale(pool,change.first,{...auth,enforceMode:false}),'duplicate');
   // Modification d'abord : l'avoir avec l'ancienne version doit être refusé.
   const modified=await makeSale(),change2=await modification(modified);
   await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",['identified-sale',modified.invoiceId]);
   const pendingEdit2=storeIdentifiedSale(pool,change2.next,{...auth,enforceMode:false}).then(value=>({value,error:null as unknown}),error=>({value:null,error}));
   await waitForBlocked(pool,blocker.processID);
   const pendingNote2=storePrototypeCreditNote(pool,modified,principal).then(value=>({value,error:null as unknown}),error=>({value:null,error}));
   await blocker.query('COMMIT');
   assert.equal((await pendingEdit2).value,'received');assert.match(String((await pendingNote2).error),/périmée/);
   const result=await pool.query('SELECT count(*)::int AS n FROM credit_note_prototype_events WHERE invoice_id=$1',[modified.invoiceId]);assert.equal(result.rows[0].n,0);

  } finally {await blocker.query('ROLLBACK').catch(()=>{});blocker.release();}
 } finally {if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
