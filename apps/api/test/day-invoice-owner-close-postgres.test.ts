import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {dayInvoiceServerSchema,storeDayInvoicePayment} from '../src/day-invoice-store.js';
import {readServerDayInvoiceSource} from '../src/day-invoice-source.js';
import {storeJournalSnapshot} from '../src/journal-store.js';
import {setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {changeTourClosure,requestTourTransition} from '../src/tour-closure-store.js';
import {readJournalCashReconciliation} from '../src/journal-cash-reconciliation-prototype.js';
import {dayInvoiceCashClosureCanonical} from '../../../packages/domain/src/day-invoice-cash.js';
import {readDayInvoiceOwnerDeclarations} from '../src/day-invoice-journal.js';
import type {DayInvoicePayment} from '../../../packages/domain/src/day-invoice.js';

test('PostgreSQL : déclaration par un autre commercial sérialisée avec la clôture du propriétaire',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');
 const schema='sls_owner_'+randomUUID().replaceAll('-',''),root=new pg.Pool({connectionString:url});let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});await pool.query(schemaSql);await pool.query(dayInvoiceServerSchema);
  const owner=randomUUID(),other=randomUUID(),client=randomUUID(),secret='secret fictif suffisamment long';
  await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[client,'Client fictif']);await pool.query('INSERT INTO commercials(id,name) VALUES($1,$2),($3,$4)',[owner,'Propriétaire',other,'Encaisseur']);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  await setCommercialCredentials(pool,'admin',owner,{login:'owner.test',password:'mot de passe fictif'});await setCommercialCredentials(pool,'admin',other,{login:'other.test',password:'mot de passe fictif'});
  const a=await loginCommercial(pool,secret,{login:'owner.test',password:'mot de passe fictif'}),b=await loginCommercial(pool,secret,{login:'other.test',password:'mot de passe fictif'});assert.ok(a&&b);
  const sessionA={secret,token:a.token},sessionB={secret,token:b.token},actor={id:owner,role:'commercial' as const};
  async function invoice(day:string){const id=randomUUID(),at=`${day}T09:00:00.000Z`,value={id,journalDate:day,clientId:client,clientName:'Client fictif',sector:'',amount:600000,createdAt:at};await storeJournalSnapshot(pool!,{operationId:randomUUID(),version:1,invoice:value,receipts:[]},'identified',{...sessionA,enforceMode:true});return id;}
  function payment(day:string,id:string,recordedAt:string):DayInvoicePayment{return {operationId:randomUUID(),clientId:client,day,recordedAt,amount:100000,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id,version:1,total:600000,declare:true},sales:[]};}
  const day='2026-02-03',id=await invoice(day),nextDay='2026-02-05',nextId=await invoice(nextDay),entry=payment(day,id,'2026-02-04T09:00:00.000Z');
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),barrier=new Promise<void>(r=>{release=r;});
  const writing=storeDayInvoicePayment(pool,entry,sessionB,async(db,event)=>{const source=await readServerDayInvoiceSource(db,event);entered();await barrier;return source;});await ready;
  const closing=changeTourClosure(pool,owner,day,'close',actor,0).then(value=>({value,error:null}),error=>({value:null,error}));
  try{assert.equal(await Promise.race([closing.then(()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),150))]),false);}finally{release();}
  assert.equal(await writing,'received');assert.match(String((await closing).error),/absents du calcul de clôture/);
  const conn=await pool.connect();let journal:Awaited<ReturnType<typeof readJournalCashReconciliation>>;
  try{assert.deepEqual(await readDayInvoiceOwnerDeclarations(conn,owner,day),[entry]);journal=await readJournalCashReconciliation(conn,owner,day);}finally{conn.release();}
  const sales={version:5,commercialId:owner,day,initialEvents:[],refundEvents:[],saleStates:[]};
  const hash=(declarations:unknown[])=>createHash('sha256').update(dayInvoiceCashClosureCanonical(sales,journal,[],owner,day,declarations)).digest('hex');
  const closeRequest={requestId:randomUUID(),day,expectedVersion:0,cashProof:hash([])};
  await assert.rejects(requestTourTransition(pool,closeRequest,{kind:'commercial',...sessionA},true,true,true,true),/Caisse différente/);
  const accepted=await requestTourTransition(pool,{...closeRequest,cashProof:hash([entry])},{kind:'commercial',...sessionA},true,true,true,true);
  assert.equal(accepted.status,'received');
  // L'encaissement reste dans la caisse de B, jamais dans celle de A.
  assert.equal(await storeDayInvoicePayment(pool,entry,sessionB,readServerDayInvoiceSource),'duplicate');
  await changeTourClosure(pool,owner,nextDay,'close',actor,0);
  const blocked=payment(nextDay,nextId,'2026-02-06T09:00:00.000Z');
  await assert.rejects(storeDayInvoicePayment(pool,blocked,sessionB,readServerDayInvoiceSource),/clôtur/i);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM identified_day_invoice_payments WHERE operation_id=$1',[blocked.operationId])).rows[0].n,0);
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
