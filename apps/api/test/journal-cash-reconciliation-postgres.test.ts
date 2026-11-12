import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeJournalSnapshot} from '../src/journal-store.js';
import {storeIdentifiedSettlement} from '../src/identified-operations.js';
import {readJournalCashReconciliation} from '../src/journal-cash-reconciliation-prototype.js';

test('PostgreSQL : comparaison des préétablies, paiements et règlements reçus par commercial',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');const root=new pg.Pool({connectionString:url}),schema='sls_jcash_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const a=await saveCommercial(pool,'admin',{name:'A',active:true}),b=await saveCommercial(pool,'admin',{name:'B',active:true});await setCommercialCredentials(pool,'admin',a.id,{login:'jc.owner',password:'mot de passe fictif'});await setCommercialCredentials(pool,'admin',b.id,{login:'jc.other',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour les tests',sa=await loginCommercial(pool,secret,{login:'jc.owner',password:'mot de passe fictif'});assert.ok(sa);
  const day='2026-11-08',cid=randomUUID(),invoiceId=randomUUID(),first=randomUUID(),second=randomUUID(),payId=randomUUID();await pool.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,$3)',[cid,'Fictif',1000000]);
  const invoice={id:invoiceId,clientId:cid,clientName:'Fictif',journalDate:day,createdAt:day+'T09:00:00.000Z',sector:'',amount:600000};
  const receipt={id:randomUUID(),preInvoiceId:invoiceId,clientId:cid,journalDate:day,createdAt:day+'T10:00:00.000Z',prePaid:250000,oldDebtPaid:400000,creditFull:false,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1000000};
  const auth={secret,token:sa.token,enforceMode:true,creditAware:true};await storeJournalSnapshot(pool,{operationId:first,version:1,invoice,receipts:[]},'identified',auth);await storeJournalSnapshot(pool,{operationId:second,version:2,invoice,receipts:[receipt]},'identified',auth);
  const settlement={syncOperationId:payId,createdAt:day+'T11:00:00.000Z',clientId:cid,clientName:'Fictif',amount:100000,mode:'Virement' as const,chequeNumber:'',chequeBank:'',chequeDue:''};await storeIdentifiedSettlement(pool,{operationId:payId,settlement},auth);
  const db=await pool.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const result=await readJournalCashReconciliation(db,a.id,day);assert.deepEqual(result.events.map(e=>e.kind).sort(),['invoice','receipt','settlement']);const r=result.events.find(e=>e.kind==='receipt');assert.ok(r&&r.kind==='receipt');assert.equal(r.prePaid,250000);assert.equal(r.oldDebtPaid,400000);assert.deepEqual((await readJournalCashReconciliation(db,b.id,day)).events,[]);await db.query('COMMIT');}finally{db.release();}
  await pool.query('UPDATE identified_settlements SET payload_hash=$2 WHERE operation_id=$1',[payId,'0'.repeat(64)]);
  const broken=await pool.connect();try{await broken.query('BEGIN');await assert.rejects(readJournalCashReconciliation(broken,a.id,day),/incohérent/);await broken.query('ROLLBACK');}finally{broken.release();}
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
