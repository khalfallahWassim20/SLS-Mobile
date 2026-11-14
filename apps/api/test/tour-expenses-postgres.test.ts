import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeTourExpense} from '../src/tour-expenses.js';
import {requestTourTransition} from '../src/tour-closure-store.js';
import {readIdentifiedJournalDay} from '../src/identified-journal-day.js';

test('PostgreSQL : dépense et clôture concurrentes, reprise sans doublon',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_expense_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const person=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});await setCommercialCredentials(pool,'admin',person.id,{login:'expense.pg',password:'mot de passe fictif'});
  const secret='secret fictif assez long pour les tests',session=await loginCommercial(pool,secret,{login:'expense.pg',password:'mot de passe fictif'});assert.ok(session);
  const op={operationId:randomUUID(),createdAt:'2026-11-08T10:00:00.000Z',description:'Carburant',amount:25350},credentials={token:session.token,secret,enforceMode:true};
  const [write,close]=await Promise.allSettled([storeTourExpense(pool,op,credentials),requestTourTransition(pool,{requestId:randomUUID(),day:'2026-11-08',expectedVersion:0},{kind:'commercial',token:session.token,secret},true)]);
  assert.equal(close.status,'fulfilled');const n=Number((await pool.query('SELECT count(*) AS n FROM identified_tour_expenses')).rows[0].n);
  if(write.status==='fulfilled'){assert.equal(write.value,'received');assert.equal(n,1);assert.equal(await storeTourExpense(pool,op,credentials),'duplicate');}else{assert.match(String(write.reason),/clôturé/);assert.equal(n,0);}
  const journal=await readIdentifiedJournalDay(pool,person.id,'2026-11-08',true);assert.equal(journal.expenseTotal,n?25350:0);assert.equal(journal.totalCollected,0);
  await assert.rejects(storeTourExpense(pool,{...op,operationId:randomUUID()},credentials),/clôturé/);
 }finally{if(pool)await pool.end();await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await root.end();}
});
