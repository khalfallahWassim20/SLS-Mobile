/** Base de test uniquement : les registres expérimentaux ne sont pas exposés. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import {schemaSql} from '../src/schema.js';
import {creditNotePrototypeSchema} from '../src/credit-note-registry-prototype.js';
import {preInvoiceCreditPrototypeSchema,storePrototypePreInvoiceCredit} from '../src/pre-invoice-credit-registry-prototype.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeJournalSnapshot} from '../src/journal-store.js';
import {lockTourClosure} from '../src/tour-closure-store.js';
import {lockIdentifiedOperation} from '../src/identified-overlap.js';
import {storePrototypeGuardedJournal} from '../src/pre-invoice-credit-journal-prototype.js';
import {readPrototypeCreditReference} from '../src/credit-note-reference-prototype.js';

dotenv.config({path:'apps/api/.env'});
async function waitBlocked(pool:pg.Pool,pid:number) {
 const end=Date.now()+5000;
 while(Date.now()<end) {
  const r=await pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid]);
  if(r.rows[0].n>=1)return;
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 throw Error('Attente du verrou non observée');
}
test('préétablie : demandes et reprises concurrentes sur PostgreSQL réel',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const schema='sls_pre_credit_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});
 let pool:pg.Pool|undefined,created=false;
 try {
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;
  pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});
  await pool.query(schemaSql);await pool.query(creditNotePrototypeSchema);await pool.query(preInvoiceCreditPrototypeSchema);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const c=await saveCommercial(pool,'admin',{name:'Fictif',active:true}),secret='secret fictif assez long pour le test';
  await setCommercialCredentials(pool,'admin',c.id,{login:'credit.test',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'credit.test',password:'mot de passe fictif'});assert.ok(session);
  const clientId=randomUUID(),auth={secret,token:session.token},principal={kind:'commercial' as const,...auth},day='2026-11-08';
  await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Client fictif']);
  async function makeInvoice(date:string) {
   const invoice={id:randomUUID(),clientId,clientName:'Client fictif',journalDate:date,createdAt:`${date}T09:00:00.000Z`,sector:'',amount:600000};
   await storeJournalSnapshot(pool!,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',auth);
   return {operationId:randomUUID(),invoiceId:invoice.id,expectedVersion:1,recordedAt:`${date}T10:00:00.000Z`,choice:null};
  }
  const cmd=await makeInvoice(day),blocker=await pool.connect();
  try {
   await blocker.query('BEGIN');await lockTourClosure(blocker,c.id,day);
   const requests=Promise.allSettled([storePrototypePreInvoiceCredit(pool,cmd,principal),storePrototypePreInvoiceCredit(pool,{...cmd,operationId:randomUUID()},principal)]);
   await waitBlocked(pool,blocker.processID);await blocker.query('COMMIT');
   const results=await requests;assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
   const rejected=results.find(r=>r.status==='rejected');assert.ok(rejected&&rejected.status==='rejected');assert.match(String(rejected.reason),/déjà annulée/);
   const retry=await makeInvoice('2026-11-09');
   await blocker.query('BEGIN');await lockIdentifiedOperation(blocker,retry.operationId);
   const requests2=Promise.allSettled([storePrototypePreInvoiceCredit(pool,retry,principal),storePrototypePreInvoiceCredit(pool,retry,principal)]);
   await waitBlocked(pool,blocker.processID);await blocker.query('COMMIT');
   const replay=await requests2;assert.ok(replay.every(r=>r.status==='fulfilled'));
   const values=replay.map(r=>{if(r.status!=='fulfilled')throw r.reason;return r.value;});
   assert.deepEqual(values.map(v=>v.status).sort(),['duplicate','received']);assert.deepEqual(values[0].event,values[1].event);
   const rows=await pool.query('SELECT count(*)::int AS n,COALESCE(sum(balance_delta),0)::text AS amount FROM pre_invoice_credit_prototype_movements');
   // Les deux factures n'avaient pas encore été déclarées dans le solde.
   assert.deepEqual(rows.rows[0],{n:2,amount:'0'});
   async function paymentFor(command:{invoiceId:string}) {
    const result=await pool!.query('SELECT payload FROM identified_journal_events WHERE invoice_id=$1 ORDER BY version DESC LIMIT 1',[command.invoiceId]);
    const first=result.rows[0].payload,invoice=first.invoice;
    const receipt={id:randomUUID(),preInvoiceId:invoice.id,clientId:invoice.clientId,journalDate:invoice.journalDate,createdAt:`${invoice.journalDate}T09:30:00.000Z`,prePaid:100000,oldDebtPaid:0,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:0};
    return {first,next:{operationId:randomUUID(),version:2,invoice,receipts:[receipt]}};
   }
   // L'avoir passe d'abord : le paiement attend, puis reste refusé.
   const cancelled=await makeInvoice('2026-11-10'),payment=await paymentFor(cancelled);
   await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",['journal-invoice',cancelled.invoiceId]);
   const noteFirst=storePrototypePreInvoiceCredit(pool,cancelled,principal);
   // Attacher un gestionnaire immédiatement pour éviter un rejet non observé.
   const settledNote=noteFirst.then(value=>({value,error:null as unknown}),error=>({value:null,error}));
   await waitBlocked(pool,blocker.processID);
   const settledPayment=storePrototypeGuardedJournal(pool,payment.next,auth).then(value=>({value,error:null as unknown}),error=>({value:null,error}));
   await blocker.query('COMMIT');
   assert.equal((await settledNote).value?.status,'received');assert.match(String((await settledPayment).error),/annulée/);
   assert.equal(await storePrototypeGuardedJournal(pool,payment.first,auth),'duplicate');
   // Le paiement passe d'abord : la demande d'avoir sur l'ancienne version échoue.
   const paidFirst=await makeInvoice('2026-11-11'),payment2=await paymentFor(paidFirst);
   await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",['journal-invoice',paidFirst.invoiceId]);
   const settledPayment2=storePrototypeGuardedJournal(pool,payment2.next,auth).then(value=>({value,error:null as unknown}),error=>({value:null,error}));
   await waitBlocked(pool,blocker.processID);
   const settledNote2=storePrototypePreInvoiceCredit(pool,paidFirst,principal).then(value=>({value,error:null as unknown}),error=>({value:null,error}));
   await blocker.query('COMMIT');
   assert.equal((await settledPayment2).value,'received');assert.match(String((await settledNote2).error),/périmée/);
   const saved=await pool.query('SELECT count(*)::int AS n FROM pre_invoice_credit_prototype_events WHERE invoice_id=$1',[paidFirst.invoiceId]);assert.equal(saved.rows[0].n,0);
   const reference=await readPrototypeCreditReference(pool);assert.equal(reference.clients[0].serverBalance,'500000');
   assert.equal(reference.journalStates.filter(s=>s.creditNote).length,3);
  }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();}
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
