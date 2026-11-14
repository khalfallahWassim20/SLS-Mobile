/** Scénario isolé : jamais exécuté sur la base principale. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale} from '../src/identified-operations.js';
import {storeJournalSnapshot} from '../src/journal-store.js';
import {requestTourTransition} from '../src/tour-closure-store.js';
import {storePrototypeCreditNote} from '../src/credit-note-registry-prototype.js';
import {storePrototypePreInvoiceCredit} from '../src/pre-invoice-credit-registry-prototype.js';
import {readPrototypeCreditJournal} from '../src/credit-note-journal-prototype.js';
import {readPrototypeCreditReference} from '../src/credit-note-reference-prototype.js';
import {matchingCashProof} from '../../../packages/domain/test/cash-close-fixture.js';

test('PostgreSQL : avoirs sur factures antérieures clôturées, sans modifier la preuve de caisse passée',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_credit_old_day_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const person=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});await setCommercialCredentials(pool,'admin',person.id,{login:'old.credit.test',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour ce scénario',session=await loginCommercial(pool,secret,{login:'old.credit.test',password:'mot de passe fictif'});assert.ok(session);
  const auth={secret,token:session.token,enforceMode:true,creditAware:true},principal={kind:'commercial' as const,secret,token:session.token};
  const day='2026-11-07',next='2026-11-08',at=`${day}T09:00:00.000Z`,clientId=randomUUID(),saleId=randomUUID(),invoiceId=randomUUID();
  await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,1000000)',[clientId,'Client fictif']);
  const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Huile',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId,version:1,recordedAt:at,sale,refund:0},auth);
  const invoice={id:invoiceId,clientId,clientName:'Client fictif',journalDate:day,createdAt:at,sector:'',amount:600000};
  const receipt={id:randomUUID(),preInvoiceId:invoiceId,clientId,journalDate:day,createdAt:`${day}T10:00:00.000Z`,prePaid:250000,oldDebtPaid:20000,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1069000};
  await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',auth);
  await storeJournalSnapshot(pool,{operationId:randomUUID(),version:2,invoice,receipts:[receipt]},'identified',auth);
  const before=await readPrototypeCreditJournal(pool,person.id,day),balanceBefore=await readPrototypeCreditReference(pool,false);
  const originalProof=await matchingCashProof(pool,person.id,day),close={requestId:randomUUID(),day,expectedVersion:0,cashProof:originalProof};
  assert.equal((await requestTourTransition(pool,close,principal,true,true)).status,'received');
  const saleNote={operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:`${next}T10:00:00.000Z`,choice:'refund' as const};
  const preNote={operationId:randomUUID(),invoiceId,expectedVersion:2,recordedAt:`${next}T11:00:00.000Z`,choice:'credit' as const};
  await assert.rejects(storePrototypeCreditNote(pool,{...saleNote,recordedAt:`${day}T12:00:00.000Z`},principal),/clôturé/);
  await assert.rejects(storePrototypePreInvoiceCredit(pool,{...preNote,recordedAt:`${day}T12:00:00.000Z`},principal),/clôturé/);
  assert.equal((await storePrototypeCreditNote(pool,saleNote,principal)).status,'received');
  assert.equal((await storePrototypePreInvoiceCredit(pool,preNote,principal)).status,'received');
  assert.equal((await storePrototypeCreditNote(pool,saleNote,principal)).status,'duplicate');
  assert.equal((await storePrototypePreInvoiceCredit(pool,preNote,principal)).status,'duplicate');
  // Pas de réécriture de la journée ni de ses opérations, et aucune preuve
  // historique recalculée ne doit changer à cause d'un événement du lendemain.
  assert.equal(await matchingCashProof(pool,person.id,day),originalProof);
  assert.equal((await requestTourTransition(pool,close,principal,true,true)).status,'duplicate');
  const after=await readPrototypeCreditJournal(pool,person.id,day),current=await readPrototypeCreditJournal(pool,person.id,next),balanceAfter=await readPrototypeCreditReference(pool,false);
  assert.equal(after.totalBilled,before.totalBilled);assert.equal(after.totalCollected,before.totalCollected);assert.equal(after.collectedAfterRefunds,before.collectedAfterRefunds);
  assert.equal(current.creditNoteTotal,719000);assert.equal(current.creditRefundTotal,50000);assert.equal(current.creditRetainedTotal,250000);
  const oldBalance=BigInt(balanceBefore.clients.find(c=>c.id===clientId)!.serverBalance),newBalance=BigInt(balanceAfter.clients.find(c=>c.id===clientId)!.serverBalance);
  assert.equal(newBalance,oldBalance-69000n-600000n);
  assert.equal((await pool.query('SELECT count(*)::int n FROM identified_journal_events WHERE invoice_id=$1',[invoiceId])).rows[0].n,2);
  assert.equal((await pool.query('SELECT status FROM tour_closures WHERE commercial_id=$1 AND journal_date=$2::date',[person.id,day])).rows[0].status,'closed');
  // Le jour de l'avoir reste soumis à la clôture et à une preuve complète.
  assert.equal((await requestTourTransition(pool,{requestId:randomUUID(),day:next,expectedVersion:0,cashProof:await matchingCashProof(pool,person.id,next)},principal,true,true)).status,'received');
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});

test('PostgreSQL : clôture ancienne et avoir du lendemain concurrents préservent la preuve historique',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_credit_old_race_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const person=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});await setCommercialCredentials(pool,'admin',person.id,{login:'old.race.test',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour ce scénario',session=await loginCommercial(pool,secret,{login:'old.race.test',password:'mot de passe fictif'});assert.ok(session);
  const auth={secret,token:session.token,enforceMode:true,creditAware:true},principal={kind:'commercial' as const,secret,token:session.token};
  for(let i=1;i<=6;i++){
   const day=`2026-10-${String(i*2-1).padStart(2,'0')}`,next=`2026-10-${String(i*2).padStart(2,'0')}`,at=`${day}T09:00:00.000Z`,clientId=randomUUID(),invoiceId=randomUUID();
   await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,100000)',[clientId,'Fictif']);
   if(i%2){
    const sale={createdAt:at,clientId,clientName:'Fictif',syncSaleId:invoiceId,syncVersion:1,lines:[{name:'Huile',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
    await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId:invoiceId,version:1,recordedAt:at,sale,refund:0},auth);
   }else{
    const invoice={id:invoiceId,clientId,clientName:'Fictif',journalDate:day,createdAt:at,sector:'',amount:600000};
    await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',auth);
   }
   const proof=await matchingCashProof(pool,person.id,day),request={requestId:randomUUID(),day,expectedVersion:0,cashProof:proof};
   const command={operationId:randomUUID(),invoiceId,expectedVersion:1,recordedAt:`${next}T10:00:00.000Z`,choice:i%2?'credit' as const:null};
   const close=()=>requestTourTransition(pool!,request,principal,true,true);
   const note=()=>i%2?storePrototypeCreditNote(pool!,command,principal):storePrototypePreInvoiceCredit(pool!,command,principal);
   const outcomes=await Promise.allSettled(i%2?[close(),note()]:[note(),close()]);
   assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,2,JSON.stringify(outcomes));
   assert.equal(await matchingCashProof(pool,person.id,day),proof);
   assert.equal((await close()).status,'duplicate');assert.equal((await note()).status,'duplicate');
  }
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
