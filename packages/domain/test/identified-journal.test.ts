import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {storeJournalSnapshot} from '../../../apps/api/src/journal-store.js';
import {changeTourClosure} from '../../../apps/api/src/tour-closure-store.js';
import {readJournalPaymentHistory} from '../../../apps/api/src/journal-payment-history.js';

test('journal identifié isolé : session, écriture et clôture atomiques',async()=>{
 const db=new PGlite(),secret='secret uniquement pour ce test local';
 try {
  await db.exec(schemaSql);await db.exec(schemaSql);
  // PGlite est mono-connexion ; les advisory locks réels sont testés séparément sur PostgreSQL.
  const conn={query:(sql:string,params?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,params),release:()=>{}};
  const pool={query:(sql:string,params?:unknown[])=>db.query(sql,params),connect:async()=>conn} as unknown as Pool;
  const c=await saveCommercial(pool,'admin',{name:'Fictif un',active:true});
  const other=await saveCommercial(pool,'admin',{name:'Fictif deux',active:true});
  await setCommercialCredentials(pool,'admin',c.id,{login:'commercial.un',password:'mot de passe fictif'});
  await setCommercialCredentials(pool,'admin',other.id,{login:'commercial.deux',password:'autre mot de passe'});
  const one=await loginCommercial(pool,secret,{login:'commercial.un',password:'mot de passe fictif'});
  const two=await loginCommercial(pool,secret,{login:'commercial.deux',password:'autre mot de passe'});assert.ok(one&&two);
  const s={token:one.token,secret},s2={token:two.token,secret};
  const clientId=randomUUID(), invoiceId=randomUUID(),day='2026-11-08';
  await db.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Client fictif']);
  const invoice={id:invoiceId,clientId,clientName:'Client fictif',journalDate:day,createdAt:'2026-11-08T09:00:00.000Z',sector:'',amount:600000};
  const first={operationId:randomUUID(),version:1,invoice,receipts:[]};
  await assert.rejects(storeJournalSnapshot(pool,first,'identified'),/Session commerciale/);
  await assert.rejects(storeJournalSnapshot(pool,first,'identified',{token:'invalide',secret}),/Session commerciale/);
  assert.equal(await storeJournalSnapshot(pool,first,'identified',s),'received');
  assert.equal(await storeJournalSnapshot(pool,first,'identified',s),'duplicate');
  await assert.rejects(storeJournalSnapshot(pool,first,'identified',s2),/autre commercial/);
  await assert.rejects(storeJournalSnapshot(pool,{...first,operationId:randomUUID()},'identified',s2),/autre commercial/);
  const receipt={id:randomUUID(),preInvoiceId:invoiceId,clientId,journalDate:day,createdAt:'2026-11-08T10:00:00.000Z',prePaid:200000,oldDebtPaid:0,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:0};
  const second={operationId:randomUUID(),version:2,invoice,receipts:[receipt]};
  await changeTourClosure(pool,c.id,day,'close',{id:c.id,role:'commercial'},0);
  // Accusé perdu : renvoi identique autorisé, mais aucune nouvelle opération après clôture.
  assert.equal(await storeJournalSnapshot(pool,first,'identified',s),'duplicate');
  await assert.rejects(storeJournalSnapshot(pool,second,'identified',s),/clôturé/);
  assert.equal((await db.query<{count:number}>('SELECT count(*)::int AS count FROM identified_journal_events')).rows[0].count,1);
  await changeTourClosure(pool,c.id,day,'reopen',{id:'admin',role:'admin'},1);
  assert.equal(await storeJournalSnapshot(pool,second,'identified',s),'received');
  const receipt2={...receipt,id:randomUUID(),createdAt:'2026-11-08T11:00:00.000Z',prePaid:50000};
  const third={operationId:randomUUID(),version:3,invoice,receipts:[receipt,receipt2]};
  assert.equal(await storeJournalSnapshot(pool,third,'identified',s),'received');
  assert.equal(await storeJournalSnapshot(pool,third,'identified',s),'duplicate');
  const history=await readJournalPaymentHistory(pool,c.id,day);
  assert.equal(history.truncated,false);assert.equal(history.entries.length,2);
  assert.deepEqual(history.entries.map(x=>x.prePaid).sort((a,b)=>a-b),[50000,200000]);
  assert.ok(history.entries.every(x=>x.commercialId===c.id && x.commercialName==='Fictif un' && !x.inherited));
  assert.equal((await readJournalPaymentHistory(pool,other.id,day)).entries.length,0);
  const rows=await db.query('SELECT commercial_id FROM identified_journal_events');
  assert.deepEqual(rows.rows.map((r:any)=>r.commercial_id),[c.id,c.id,c.id]);
  assert.equal((await db.query<{count:number}>('SELECT count(*)::int AS count FROM sync_journal_events')).rows[0].count,0);
  await saveCommercial(pool,'admin',{name:'Fictif un',active:false},c.id);
  await assert.rejects(storeJournalSnapshot(pool,second,'identified',s),/Session commerciale/);
 } finally {await db.close();}
});
