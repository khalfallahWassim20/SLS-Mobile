/** Essais de concurrence : uniquement des schémas éphémères fictifs. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale,storeIdentifiedSettlement} from '../src/identified-operations.js';
import {storeJournalSnapshot} from '../src/journal-store.js';
import {requestTourTransition} from '../src/tour-closure-store.js';
import {storePrototypeCreditNote} from '../src/credit-note-registry-prototype.js';
import {readIdentifiedReference} from '../src/identified-reference.js';
import {lockSyncMode} from '../src/tour-sync-mode.js';

async function waitBlocked(pool:pg.Pool,pid:number) {
 const end=Date.now()+5000;
 while(Date.now()<end){const r=await pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid]);if(r.rows[0].n)return;await new Promise(r=>setTimeout(r,25));}
 throw Error('Attente PostgreSQL non observée');
}
test('barrière de protocole : avoir et anciennes écritures concurrents, reprises et ancienne référence',async()=>{
 const root=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='sls_credit_barrier_'+randomUUID().replaceAll('-','');
 let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:10});
  await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const c=await saveCommercial(pool,'admin',{name:'Fictif',active:true}),secret='secret fictif assez long pour les tests';
  await setCommercialCredentials(pool,'admin',c.id,{login:'barrier.test',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'barrier.test',password:'mot de passe fictif'});assert.ok(session);
  const auth={secret,token:session.token,enforceMode:true},principal={kind:'commercial' as const,secret,token:session.token},clientId=randomUUID(),at='2026-11-08T09:00:00.000Z';
  await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Client fictif']);
  const saleId=randomUUID(),sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:0,remaining:119000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
  const first={operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0};
  assert.equal(await storeIdentifiedSale(pool,first,auth),'received');
  const cmd={operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:'2026-11-08T10:00:00.000Z',choice:null};
  const invoice={id:randomUUID(),clientId,clientName:'Client fictif',journalDate:'2026-11-08',createdAt:at,sector:'',amount:600000};
  const journal={operationId:randomUUID(),version:1,invoice,receipts:[]};
  assert.equal(await storeJournalSnapshot(pool,journal,'identified',auth),'received');
  const hold=await pool.connect();
  try{
   // Une ancienne transaction commencée en premier termine avant l'avoir.
   await hold.query('BEGIN');await lockSyncMode(hold);
   const firstNote=storePrototypeCreditNote(pool,cmd,principal).then(v=>({value:v,error:null as unknown}),error=>({value:null,error}));
   await waitBlocked(pool,hold.processID);await hold.query('COMMIT');assert.equal((await firstNote).value?.status,'received');
   assert.equal(await storeIdentifiedSale(pool,first,auth),'duplicate');
   assert.equal(await storeJournalSnapshot(pool,journal,'identified',auth),'duplicate');
   await assert.rejects(readIdentifiedReference(pool,true,true),/avoirs existent/);
   const next={...first,operationId:randomUUID(),version:2,recordedAt:'2026-11-08T11:00:00.000Z',sale:{...sale,syncVersion:2}};
   await assert.rejects(storeIdentifiedSale(pool,next,auth),/avoirs existent/);
   const op=randomUUID(),settlement={operationId:op,settlement:{syncOperationId:op,createdAt:at,clientId,clientName:'Client fictif',amount:1,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}};
   await assert.rejects(storeIdentifiedSettlement(pool,settlement,auth),/avoirs existent/);
   const receipt={id:randomUUID(),preInvoiceId:invoice.id,clientId,journalDate:invoice.journalDate,createdAt:'2026-11-08T09:30:00.000Z',prePaid:1,oldDebtPaid:0,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:0};
   await assert.rejects(storeJournalSnapshot(pool,{operationId:randomUUID(),version:2,invoice,receipts:[receipt]},'identified',auth),/avoirs existent/);
   await assert.rejects(requestTourTransition(pool,{requestId:randomUUID(),day:'2026-11-08',expectedVersion:0},{kind:'commercial',secret,token:session.token},true),/avoirs existent/);
   // Remise à zéro des seules tables d'avoir dans ce schéma de test jetable,
   // pour tester l'autre ordre avec le vrai service d'écriture.
   await pool.query('DELETE FROM credit_note_prototype_movements');
   await pool.query('DELETE FROM credit_note_prototype_events');
   await pool.query('DELETE FROM credit_note_prototype_operation_ids');
   const noteConnection=await pool.connect();
   try {
    await hold.query('BEGIN');await hold.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",['identified-sale',saleId]);
    const wrapped={connect:async()=>({query:noteConnection.query.bind(noteConnection),release:()=>{}})} as unknown as pg.Pool;
    const secondNote=storePrototypeCreditNote(wrapped,{...cmd,operationId:randomUUID()},principal).then(v=>({value:v,error:null as unknown}),error=>({value:null,error}));
    await waitBlocked(pool,hold.processID); // l'avoir détient déjà la barrière exclusive
    const newId=randomUUID(),newSale={...sale,syncSaleId:newId};
    const oldWrite=storeIdentifiedSale(pool,{...first,operationId:randomUUID(),saleId:newId,sale:newSale},auth).then(v=>({value:v,error:null as unknown}),error=>({value:null,error}));
    await waitBlocked(pool,noteConnection.processID);await hold.query('COMMIT');
    assert.equal((await secondNote).value?.status,'received');
    assert.match(String((await oldWrite).error),/avoirs existent/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1',[newId])).rows[0].n,0);
   }finally{noteConnection.release();}

  }finally{await hold.query('ROLLBACK').catch(()=>{});hold.release();}
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
