import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import express from 'express';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {identifiedCommercialRoutes,identifiedAdminRoutes} from '../../../apps/api/src/identified-tour-routes.js';
import {identifiedDeviceSchema} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema,findTourCloseAttempt,acknowledgeTourClose,observeVerifiedTourState,assertLocalTourWritable} from '../../../apps/mobile/tour-close-queue.js';
import {preparePrototypeClose} from '../../../apps/mobile/credit-note-close-prototype.js';
import {offlineCreditPrototypeSchema,readReadyOfflineCreditPrototype,readAllOfflineCreditPrototype,acknowledgeOfflineCreditPrototype,type Note} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {creditSourcesPrototypeSchema,saveCreditSourcesPrototype,readCreditSourcesPrototype} from '../../../apps/mobile/credit-note-sources-prototype.js';
import {saveVerifiedCreditReference} from '../../../apps/mobile/credit-note-sync-reference.js';
import {readPrototypeCreditBalance} from '../../../apps/mobile/credit-note-balance-storage-prototype.js';
import {previewLocalCredit,confirmLocalCreditReview} from '../../../apps/mobile/credit-note-review-prototype.js';
import {readIdentifiedOutbox,acknowledgeIdentifiedOutbox} from '../../../apps/mobile/identified-outbox.js';
import {uploadIdentifiedOperations} from '../../../apps/mobile/identified-upload.js';
import {saveAndVerifyFinalCreditReference} from '../../../apps/mobile/credit-note-sync-final-prototype.js';
import {syncCreditPrototype} from '../../../apps/mobile/credit-note-sync-prototype.js';
import {createCreditTransportPrototype} from '../../../apps/mobile/credit-note-transport-prototype.js';
import {readCreditSourceChoices} from '../../../apps/mobile/credit-note-source-choices-prototype.js';
import {readCreditJournalExportPrototype} from '../../../apps/mobile/credit-note-journal-export-prototype.js';
import {journalCsv} from '../../../apps/mobile/journal-export.js';
import {describeCreditJournalPrototype} from '../../../apps/mobile/credit-note-journal-view-model-prototype.js';
import {assertLegacyMobileCreditSafe,assertCreditWritePrototype} from '../../../apps/mobile/credit-note-write-guard-prototype.js';
import {bindAndCacheCreditReferencePrototype} from '../../../apps/mobile/credit-note-binding-prototype.js';
import {readCreditClientsPrototype} from '../../../apps/mobile/credit-client-view-prototype.js';

export type CreditScenarioDatabase={exec:(sql:string)=>Promise<unknown>;query:<T extends Record<string,unknown>=Record<string,unknown>>(sql:string,args?:unknown[])=>Promise<{rows:T[]}>};
export async function runCreditCrossDeviceScenario(db:CreditScenarioDatabase,pool:Pool){
 const mobile=new DatabaseSync(':memory:'),firstPhone=new DatabaseSync(':memory:');let server:ReturnType<ReturnType<typeof express>['listen']>|undefined;
 try {
  await db.exec(schemaSql);await db.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif assez long pour les tests';
  const first=await saveCommercial(pool,'admin',{name:'Premier',active:true}),second=await saveCommercial(pool,'admin',{name:'Deuxième',active:true});
  await setCommercialCredentials(pool,'admin',first.id,{login:'first.test',password:'mot de passe fictif'});await setCommercialCredentials(pool,'admin',second.id,{login:'second.test',password:'mot de passe fictif'});
  const a=await loginCommercial(pool,secret,{login:'first.test',password:'mot de passe fictif'}),b=await loginCommercial(pool,secret,{login:'second.test',password:'mot de passe fictif'});assert.ok(a&&b);
  const clientId=randomUUID(),client2=randomUUID();await db.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,1000000),($3,$4,0)',[clientId,'Client fictif',client2,'Z Client fictif']);
  await db.query('INSERT INTO articles(id,code,name,purchase_ttc,sale_ttc) VALUES($1,$2,$3,$4,$5)',[randomUUID(),'ART-TEST','Huile fictive',42000,60000]);
  const app=express();app.use(express.json());app.use('/v5',identifiedCommercialRoutes(pool,secret,{allowCreditProtocol:true}));app.use('/admin',identifiedAdminRoutes(pool,(req,res,next)=>{if(req.get('Authorization')!=='Bearer admin-test')res.sendStatus(401);else next();},'admin',{allowCreditProtocol:true}));server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));
  const addr=server.address();assert.ok(addr&&typeof addr!=='string');const origin=`http://127.0.0.1:${addr.port}`,identity={commercialId:second.id,serverOrigin:'https://sync.example.test'};
  const headers=(token:string)=>({Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-SLS-Reference-Version':'5'});
  const post=(token:string,path:string,body:unknown)=>fetch(`${origin}/v5/${path}`,{method:'POST',headers:headers(token),body:JSON.stringify(body)});
  const get=async(path:string)=>{const r=await fetch(`${origin}/v5/${path}`,{headers:headers(b.token)});if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();};
  const saleId=randomUUID(),at='2026-11-08T09:00:00.000Z',sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:saleId,syncVersion:1,lines:[{name:'Produit',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:50000,remaining:69000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
  const invoiceId=randomUUID(),day='2026-11-08',invoice={id:invoiceId,clientId,clientName:'Client fictif',journalDate:day,createdAt:at,sector:'',amount:600000};
  const receipt={id:randomUUID(),preInvoiceId:invoiceId,clientId,journalDate:day,createdAt:'2026-11-08T10:00:00.000Z',prePaid:250000,oldDebtPaid:400000,creditFull:false,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1000000};
  // Premier appareil : les trois versions sont d'abord enregistrées hors
  // ligne, puis envoyées via sa propre file SQLite et sa propre identité.
  firstPhone.exec(`CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,version INTEGER,payload TEXT);${identifiedDeviceSchema}`);
  const firstId={commercialId:first.id,serverOrigin:identity.serverOrigin};firstPhone.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(first.id,firstId.serverOrigin);
  const salesOp=randomUUID(),invoiceOp=randomUUID(),receiptOp=randomUUID();
  const initialSale={operationId:salesOp,saleId,version:1,sale,refund:0},initialJournal={operationId:invoiceOp,version:1,invoice,receipts:[]},paidJournal={operationId:receiptOp,version:2,invoice,receipts:[receipt]};
  firstPhone.prepare('INSERT INTO sales_outbox VALUES(1,?,?,1,?)').run(salesOp,saleId,JSON.stringify(initialSale));
  firstPhone.prepare('INSERT INTO journal_sync_outbox VALUES(1,?,?,1,?)').run(invoiceOp,invoiceId,JSON.stringify(initialJournal));firstPhone.prepare('INSERT INTO journal_sync_outbox VALUES(2,?,?,2,?)').run(receiptOp,invoiceId,JSON.stringify(paidJournal));
  for(const [operation,kind,entity,recorded] of [[salesOp,'sale',saleId,at],[invoiceOp,'journal',invoiceId,at],[receiptOp,'journal',invoiceId,receipt.createdAt]])firstPhone.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(operation,first.id,kind,entity,recorded);
  const firstTx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>firstPhone.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>firstPhone.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{firstPhone.prepare(sql).run(...args)}};
  const firstTransaction=async<T>(action:()=>Promise<T>)=>{firstPhone.exec('BEGIN');try{const v=await action();firstPhone.exec('COMMIT');return v;}catch(e){firstPhone.exec('ROLLBACK');throw e;}};
  const entries=await firstTransaction(()=>readIdentifiedOutbox(firstTx,firstId)),entryMap=new Map(entries.map(x=>[x.operationId,x]));assert.equal(entries.length,3);
  const ack=async(id:string)=>{const entry=entryMap.get(id);if(!entry)throw Error('Opération introuvable');await firstTransaction(()=>acknowledgeIdentifiedOutbox(firstTx,firstId,entry));};
  await assert.rejects(uploadIdentifiedOperations(entries,firstId,firstId,async()=>{throw Error('hors ligne');},ack),/hors ligne/);
  assert.equal((await firstTransaction(()=>readIdentifiedOutbox(firstTx,firstId))).length,3);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM identified_sale_events')).rows[0].n,0);
  let loseFirst=true;const sendFirst=async(path:string,body:string)=>{const response=await fetch(`${origin}/v5/${path}`,{method:'POST',headers:headers(a.token),body});if(loseFirst){loseFirst=false;assert.equal(response.status,201);throw Error('réponse de vente perdue');}return response;};
  await assert.rejects(uploadIdentifiedOperations(entries,firstId,firstId,sendFirst,ack),/réponse de vente perdue/);
  assert.equal((await firstTransaction(()=>readIdentifiedOutbox(firstTx,firstId))).length,3);assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM identified_sale_events')).rows[0].n,1);
  assert.equal(await uploadIdentifiedOperations(entries,firstId,firstId,sendFirst,ack),3);
  assert.equal((await firstTransaction(()=>readIdentifiedOutbox(firstTx,firstId))).length,0);assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM identified_sale_events')).rows[0].n,1);
  mobile.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
   CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT PRIMARY KEY,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT PRIMARY KEY,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);
   CREATE TABLE journal_sync_state(invoice_id TEXT PRIMARY KEY,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,version INTEGER,payload TEXT);
   ${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}${creditSourcesPrototypeSchema}`);
  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>mobile.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>mobile.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{mobile.prepare(sql).run(...args)}};
  const transaction=async<T>(action:()=>Promise<T>)=>{mobile.exec('BEGIN');try{const v=await action();mobile.exec('COMMIT');return v;}catch(e){mobile.exec('ROLLBACK');throw e;}};
  const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');mobile.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(second.id,identity.serverOrigin);
  const reference=await get('reference');
  // Un nouveau téléphone peut se lier directement en v5, sans créer de
  // référence v3 qui ignorerait les avoirs. Tout échec annule aussi la liaison.
  mobile.exec('DELETE FROM identified_device');
  await assert.rejects(transaction(()=>bindAndCacheCreditReferencePrototype(tx,identity,identity,{...reference,version:3},digest,()=>{})),/Référence/);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM identified_device').get()?.n,0);
  await assert.rejects(transaction(()=>bindAndCacheCreditReferencePrototype(tx,identity,{...identity,commercialId:randomUUID()},reference,digest,()=>{})),/Session/);
  mobile.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(randomUUID(),saleId,1,'{}');
  await assert.rejects(transaction(()=>bindAndCacheCreditReferencePrototype(tx,identity,identity,reference,digest,()=>{})),/opérations en attente/);mobile.exec('DELETE FROM sales_outbox');
  let checks=0;await assert.rejects(transaction(()=>bindAndCacheCreditReferencePrototype(tx,identity,identity,reference,digest,()=>{if(++checks===2)throw Error('session expirée');})),/session expirée/);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM identified_device').get()?.n,0);
  await transaction(()=>bindAndCacheCreditReferencePrototype(tx,identity,identity,reference,digest,()=>{}));
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM identified_device').get()?.n,1);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM identified_reference_cache').get()?.n,0);
  await transaction(()=>saveVerifiedCreditReference(tx,identity,identity,reference,digest));
  const sources=await get(`credit-sources/${clientId}`);await transaction(()=>saveCreditSourcesPrototype(tx,identity,identity,clientId,sources,digest));
  // Même hors ligne et sans cache des autres appareils, les factures locales
  // identifiées restent sélectionnables, y compris leurs versions en file.
  const localSaleId=randomUUID(),localInvoiceId=randomUUID(),localSale={...sale,syncSaleId:localSaleId},localInvoice={...invoice,id:localInvoiceId},localReceipt={...receipt,id:randomUUID(),preInvoiceId:localInvoiceId},localOperation=randomUUID();
  mobile.prepare('INSERT INTO sales(client_id,payload) VALUES(?,?)').run(clientId,JSON.stringify(localSale));
  mobile.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(randomUUID(),localSaleId,1,'{}');
  mobile.prepare('INSERT INTO tour_pre_invoices(id,client_id,journal_date,payload) VALUES(?,?,?,?)').run(localInvoiceId,clientId,day,JSON.stringify(localInvoice));
  mobile.prepare('INSERT INTO tour_journal_receipts(id,pre_invoice_id,client_id,journal_date,payload) VALUES(?,?,?,?,?)').run(localReceipt.id,localInvoiceId,clientId,day,JSON.stringify(localReceipt));
  mobile.prepare('INSERT INTO journal_sync_state(invoice_id,version,payload) VALUES(?,?,?)').run(localInvoiceId,2,JSON.stringify({operationId:localOperation,version:2,invoice:localInvoice,receipts:[localReceipt]}));
  for(const [id,kind] of [[localSaleId,'sale'],[localInvoiceId,'journal']])mobile.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(randomUUID(),identity.commercialId,kind,id,at);
  mobile.exec('DELETE FROM credit_sources_prototype_cache');
  const localChoices=await transaction(()=>readCreditSourceChoices(tx,identity,clientId,digest));assert.equal(localChoices.remoteAvailable,false);assert.equal(localChoices.items.length,2);assert.ok(localChoices.items.every(x=>x.origin==='local'&&!x.blocked));assert.equal(localChoices.items.find(x=>x.kind==='preinvoice')?.paid,250000);assert.equal(localChoices.items.find(x=>x.kind==='preinvoice')?.oldDebtPaid,400000);
  mobile.prepare('UPDATE tour_journal_receipts SET payload=? WHERE id=?').run(JSON.stringify({...localReceipt,oldDebtPaid:1}),localReceipt.id);await assert.rejects(transaction(()=>readCreditSourceChoices(tx,identity,clientId,digest)),/Historique local/);mobile.prepare('UPDATE tour_journal_receipts SET payload=? WHERE id=?').run(JSON.stringify(localReceipt),localReceipt.id);
  await transaction(()=>saveCreditSourcesPrototype(tx,identity,identity,clientId,sources,digest));
  assert.equal((await transaction(()=>readCreditSourceChoices(tx,identity,clientId,digest))).items.length,4);
  mobile.exec('DELETE FROM sales;DELETE FROM sales_outbox;DELETE FROM tour_journal_receipts;DELETE FROM tour_pre_invoices;DELETE FROM journal_sync_state;DELETE FROM identified_local_operations');
  // L'écran v3 peut écrire avant tout avoir ; la future écriture v5 vérifie
  // le même solde dans la transaction, sans traiter une limite de zéro comme blocage.
  await transaction(()=>assertLegacyMobileCreditSafe(tx,identity));
  const context={identity,expectedBalance:1019000};
  assert.equal((await transaction(()=>assertCreditWritePrototype(tx,context,{kind:'sale',clientId},digest))).balance,1019000);
  const initialView=await transaction(()=>readCreditClientsPrototype(tx,identity,digest));assert.equal(initialView.version,5);assert.equal(initialView.clients[0].balance,1019000);assert.equal(initialView.clients[0].saleBlocked,false);assert.equal(initialView.pendingCredits,0);assert.equal(initialView.articles[0].saleTtc,'60000');assert.equal('purchaseTtc' in initialView.articles[0],false);
  const counted:string[]=[],txCount={...tx,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>{counted.push(sql);return tx.getAllAsync<T>(sql,...args);}};const multiView=await transaction(()=>readCreditClientsPrototype(txCount,identity,digest));assert.equal(multiView.clients.length,2);assert.equal(multiView.clients.find(c=>c.id===client2)?.balance,0);assert.equal(counted.filter(sql=>sql.includes('FROM sales ORDER BY id')).length,1);
  const unknownClient=randomUUID();mobile.prepare('INSERT INTO sales(client_id,payload) VALUES(?,?)').run(unknownClient,JSON.stringify({...sale,clientId:unknownClient}));
  await assert.rejects(transaction(()=>readCreditClientsPrototype(tx,identity,digest)),/absent de la référence/);mobile.exec('DELETE FROM sales');
  await assert.rejects(transaction(()=>assertCreditWritePrototype(tx,{...context,expectedBalance:1018999},{kind:'sale',clientId},digest)),/Solde modifié/);
  await assert.rejects(transaction(()=>assertCreditWritePrototype(tx,{...context,identity:{...identity,commercialId:randomUUID()}},{kind:'sale',clientId},digest)),/Identité|incohérent/);
  await assert.rejects(transaction(()=>assertCreditWritePrototype(tx,context,{kind:'preinvoice',clientId,day},digest)),/existe déjà/);
  await assert.rejects(transaction(()=>assertCreditWritePrototype(tx,context,{kind:'settlement',clientId,amount:1019001},digest)),/ne pas dépasser/);
  const rawCache=mobile.prepare('SELECT payload FROM credit_reference_prototype_cache WHERE id=1').get()!.payload as string,changed=JSON.parse(rawCache);changed.clients.find((x:{id:string})=>x.id===clientId).creditLimit='1019000';mobile.prepare('UPDATE credit_reference_prototype_cache SET payload=? WHERE id=1').run(JSON.stringify(changed));
  await assert.rejects(transaction(()=>assertCreditWritePrototype(tx,context,{kind:'sale',clientId},digest)),/Limite de crédit/);
  changed.clients.find((x:{id:string})=>x.id===clientId).active=false;mobile.prepare('UPDATE credit_reference_prototype_cache SET payload=? WHERE id=1').run(JSON.stringify(changed));
  const disabledView=await transaction(()=>readCreditClientsPrototype(tx,identity,digest));assert.equal(disabledView.clients[0].blockReason,'client-inactif');assert.equal(disabledView.clients[0].balance,1019000);
  await assert.rejects(transaction(()=>assertCreditWritePrototype(tx,context,{kind:'preinvoice',clientId,day:'2026-11-09'},digest)),/désactivé/);
  mobile.prepare('UPDATE credit_reference_prototype_cache SET payload=? WHERE id=1').run(rawCache);
  const saleCommand={operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:'2026-11-08T11:00:00.000Z',choice:'refund' as const};
  const preCommand={operationId:randomUUID(),invoiceId,expectedVersion:2,recordedAt:'2026-11-08T11:00:00.000Z',choice:'credit' as const};
  const saleReview=await transaction(()=>previewLocalCredit(tx,identity,clientId,'sale',{...saleCommand,operationId:randomUUID()},digest));assert.equal(saleReview.beforeBalance,1019000);assert.equal(saleReview.afterBalance,950000);
  await transaction(()=>confirmLocalCreditReview(tx,identity,saleReview,saleCommand,digest));
  await assert.rejects(transaction(()=>assertLegacyMobileCreditSafe(tx,identity)),/Des avoirs existent/);
  assert.equal((await transaction(()=>assertCreditWritePrototype(tx,{identity,expectedBalance:950000},{kind:'sale',clientId},digest))).balance,950000);
  const preReview=await transaction(()=>previewLocalCredit(tx,identity,clientId,'preinvoice',{...preCommand,operationId:randomUUID()},digest));assert.equal(preReview.afterBalance,350000);
  await transaction(()=>confirmLocalCreditReview(tx,identity,preReview,preCommand,digest));
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM sales').get()?.n,0);assert.equal(mobile.prepare('SELECT count(*) AS n FROM tour_pre_invoices').get()?.n,0);
  assert.deepEqual(await transaction(()=>readPrototypeCreditBalance(tx,identity,clientId,digest)),{balance:350000,conflict:false});
  const preparedView=await transaction(()=>readCreditClientsPrototype(tx,identity,digest));assert.equal(preparedView.clients[0].balance,350000);assert.equal(preparedView.pendingCredits,2);assert.equal(preparedView.pendingOperations,0);
  const exportBefore=await transaction(()=>readCreditJournalExportPrototype(tx,identity,day,'Deuxième',digest));
  const exportModel=describeCreditJournalPrototype(exportBefore);assert.equal(exportModel.totals.creditNotes,719000);assert.equal(exportModel.totals.refunds,50000);assert.equal(exportModel.totals.retainedCredit,250000);assert.equal(exportModel.totals.billedAfterLocalCredits,-719000);
  const exportCsv=journalCsv(exportBefore);assert.match(exportCsv,/AVOIRS CRÉÉS CE JOUR/);assert.match(exportCsv,/en attente/);assert.match(exportCsv,/719,000/);assert.match(exportCsv,/'-719,000/);assert.match(exportCsv,/50,000/);assert.match(exportCsv,/250,000/);
  await assert.rejects(transaction(()=>readCreditJournalExportPrototype(tx,identity,'2026-02-30','Deuxième',digest)),/Date ou commercial invalide/);
  let lose=true;
  const io={readOperations:()=>transaction(()=>readIdentifiedOutbox(tx,identity)),acknowledgeOperation:(entry:Awaited<ReturnType<typeof readIdentifiedOutbox>>[number])=>transaction(()=>acknowledgeIdentifiedOutbox(tx,identity,entry)),
   readReadyCredits:()=>transaction(()=>readReadyOfflineCreditPrototype(tx,identity)),readAllCredits:()=>transaction(()=>readAllOfflineCreditPrototype(tx,identity)),acknowledgeCredit:(note:Note,response:unknown)=>transaction(()=>acknowledgeOfflineCreditPrototype(tx,identity,note,response)),
   sendOperation:(path:string,body:string)=>fetch(`${origin}/v5/${path}`,{method:'POST',headers:headers(b.token),body}),
   sendCredit:async(path:string,body:string)=>{const r=await fetch(`${origin}/v5/credit-notes/${path}`,{method:'POST',headers:headers(b.token),body});if(lose){lose=false;assert.equal(r.status,201);throw Error('réponse perdue');}return r;},
   fetchReference:()=>get('reference'),saveReference:(x:typeof identity,y:typeof identity,v:unknown)=>transaction(async()=>{await saveVerifiedCreditReference(tx,x,y,v,digest);}),saveFinalReference:(x:typeof identity,y:typeof identity,v:unknown)=>transaction(()=>saveAndVerifyFinalCreditReference(tx,x,y,v,digest))};
  // Le contrôleur de transport utilise les véritables échanges HTTP et les
  // wrappers SQLite, mais le nom de serveur public est routé vers le test local.
  let clock=Date.now(),expireDuringAck=false,loseClose=false,expireCloseAck=false;
  const makeController=()=>{
   const expiry=clock+3600000,session={id:second.id,name:'Deuxième',serverOrigin:identity.serverOrigin,token:b.token,expiresAt:new Date(expiry).toISOString()};
   return createCreditTransportPrototype(session,identity,{
    now:()=>clock,
    request:async(url,options)=>{const response=await fetch(url.replace(identity.serverOrigin+'/api/mobile/identified',origin+'/v5'),options);if(options.method==='POST'&&url.includes('/credit-notes/')&&lose){lose=false;assert.equal(response.status,201);throw Error('réponse perdue');}if(options.method==='POST'&&url.endsWith('/close')&&loseClose){loseClose=false;assert.equal(response.status,201);throw Error('clôture réponse perdue');}return response;},
    cacheReference:(x,y,v,guard)=>transaction(async()=>{guard();await saveVerifiedCreditReference(tx,x,y,v,digest);guard();}),
    cacheSources:(x,y,id,v,guard)=>transaction(async()=>{guard();await saveCreditSourcesPrototype(tx,x,y,id,v,digest);guard();}),
    synchronize:(x,y,transport,guard)=>syncCreditPrototype(x,y,{...io,...transport,
     acknowledgeCredit:(note,response)=>transaction(async()=>{guard();await acknowledgeOfflineCreditPrototype(tx,identity,note,response);if(expireDuringAck){expireDuringAck=false;clock=expiry;}guard();}),
     saveReference:(id,verified,value)=>transaction(async()=>{guard();await saveVerifiedCreditReference(tx,id,verified,value,digest);guard();}),
     saveFinalReference:(id,verified,value)=>transaction(async()=>{guard();await saveAndVerifyFinalCreditReference(tx,id,verified,value,digest);guard();})}),
    tour:{
     getAttempt:(id,date,guard)=>transaction(async()=>{guard();const value=await findTourCloseAttempt(tx,id.commercialId,date);guard();return value;}),
     prepare:(id,date,version,guard)=>transaction(async()=>{guard();const value=await preparePrototypeClose(tx,id,date,version,randomUUID);guard();return value;}),
     acknowledge:(id,date,response,guard)=>transaction(async()=>{guard();await acknowledgeTourClose(tx,id.commercialId,date,response);if(expireCloseAck){expireCloseAck=false;clock=expiry;}guard();}),
     observe:(id,date,response,guard)=>transaction(async()=>{guard();await observeVerifiedTourState(tx,id.commercialId,date,response);guard();})
    }
   });
  };
  let controller=makeController();
  await controller.refreshSources(clientId);
  await assert.rejects(controller.synchronize(),/réponse perdue/);
  assert.equal((await transaction(()=>readAllOfflineCreditPrototype(tx,identity))).filter(x=>x.pending).length,2);
  // L'expiration entre l'accusé et le commit doit annuler la transaction.
  expireDuringAck=true;await assert.rejects(controller.synchronize(),/expirée/);
  assert.equal((await transaction(()=>readAllOfflineCreditPrototype(tx,identity))).filter(x=>x.pending).length,2);
  controller=makeController();assert.deepEqual(await controller.synchronize(),{operations:0,credits:2});
  assert.deepEqual(await transaction(()=>readPrototypeCreditBalance(tx,identity,clientId,digest)),{balance:350000,conflict:false});
  assert.match(journalCsv(await transaction(()=>readCreditJournalExportPrototype(tx,identity,day,'Deuxième',digest))),/synchronisé/);
  // Les deux factures existent sur ce téléphone, mais leurs annulations sont
  // connues uniquement par la référence serveur (créées sur un autre appareil).
  mobile.exec('SAVEPOINT remote_export');mobile.exec('DELETE FROM offline_credit_prototype');await assert.rejects(assertLegacyMobileCreditSafe(tx,identity),/Des avoirs existent/);mobile.prepare('INSERT INTO sales(client_id,payload) VALUES(?,?)').run(clientId,JSON.stringify(sale));
  mobile.prepare('INSERT INTO tour_pre_invoices(id,client_id,journal_date,payload) VALUES(?,?,?,?)').run(invoiceId,clientId,day,JSON.stringify(invoice));
  mobile.prepare('INSERT INTO tour_journal_receipts(id,pre_invoice_id,client_id,journal_date,payload) VALUES(?,?,?,?,?)').run(receipt.id,invoiceId,clientId,day,JSON.stringify(receipt));
  const preSource=sources.items.find((x:{kind:string})=>x.kind==='preinvoice').source;
  mobile.prepare('INSERT INTO journal_sync_state(invoice_id,version,payload) VALUES(?,?,?)').run(invoiceId,2,JSON.stringify(preSource));
  const remoteExport=await readCreditJournalExportPrototype(tx,identity,day,'Deuxième',digest),remoteCsv=journalCsv(remoteExport);
  assert.equal(remoteExport.remoteCancellations?.length,2);const remoteModel=describeCreditJournalPrototype(remoteExport);assert.equal(remoteModel.hasRemoteCancellations,true);assert.equal(remoteModel.rows[0].preInvoice?.cancellation?.origin,'remote');assert.equal(remoteModel.rows[0].sales[0].cancellation?.origin,'remote');assert.equal(remoteModel.totals.creditNotes,0);assert.equal(remoteModel.totals.oldDebtPaid,400000);assert.match(remoteCsv,/Vente supplémentaire — annulée par avoir/);assert.match(remoteCsv,/Facture préétablie — annulée par avoir/);assert.match(remoteCsv,/enregistré ailleurs/);assert.match(remoteCsv,/Ces avoirs et leurs remboursements ne sont pas ajoutés aux totaux/);assert.match(remoteCsv,/400,000/);
  // Une écriture locale en attente ou une source modifiée ne doit pas être
  // considérée comme la facture annulée vérifiée.
  mobile.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(randomUUID(),saleId,1,'{}');
  await assert.rejects(readCreditJournalExportPrototype(tx,identity,day,'Deuxième',digest),/conflit|non confirmée/);mobile.exec('DELETE FROM sales_outbox');
  mobile.prepare('UPDATE sales SET payload=?').run(JSON.stringify({...sale,total:sale.total+1}));
  await assert.rejects(readCreditJournalExportPrototype(tx,identity,day,'Deuxième',digest),/conflit|non confirmée/);
  mobile.prepare('UPDATE sales SET payload=?').run(JSON.stringify(sale));
  mobile.prepare('INSERT INTO journal_sync_outbox(operation_id,invoice_id,version,payload) VALUES(?,?,?,?)').run(randomUUID(),invoiceId,2,'{}');
  await assert.rejects(readCreditJournalExportPrototype(tx,identity,day,'Deuxième',digest),/conflit|non confirmée/);mobile.exec('DELETE FROM journal_sync_outbox');
  mobile.prepare('UPDATE tour_journal_receipts SET payload=?').run(JSON.stringify({...receipt,oldDebtPaid:1}));
  await assert.rejects(readCreditJournalExportPrototype(tx,identity,day,'Deuxième',digest),/incohérent|non confirmée/);
  mobile.exec('ROLLBACK TO remote_export; RELEASE remote_export');
  await assert.rejects(transaction(()=>readCreditSourcesPrototype(tx,identity,clientId,digest)),/non confirmée|incomplètes/);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM credit_note_prototype_events')).rows[0].n,1);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM pre_invoice_credit_prototype_events')).rows[0].n,1);
  // Clôture v5 après les avoirs : le serveur reçoit la demande mais la réponse
  // est perdue. La reprise garde le même UUID et les écritures restent bloquées.
  const closedDay='2026-11-08';loseClose=true;await assert.rejects(controller.closeDay(closedDay),/réponse perdue/);
  const attempt=await transaction(()=>findTourCloseAttempt(tx,identity.commercialId,closedDay));assert.equal(attempt?.status,'closing');
  await assert.rejects(transaction(()=>assertLocalTourWritable(tx,identity.commercialId,closedDay)),/Clôture en attente/);
  const waiting=randomUUID();mobile.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(waiting,saleId,1,'{}');
  await assert.rejects(controller.closeDay(closedDay),/opération est en attente/);mobile.prepare('DELETE FROM sales_outbox WHERE operation_id=?').run(waiting);
  expireCloseAck=true;await assert.rejects(controller.closeDay(closedDay),/expirée/);
  assert.equal((await transaction(()=>findTourCloseAttempt(tx,identity.commercialId,closedDay)))?.status,'closing');
  controller=makeController();assert.deepEqual(await controller.closeDay(closedDay),{status:'closed',version:1});
  assert.equal((await transaction(()=>findTourCloseAttempt(tx,identity.commercialId,closedDay)))?.requestId,attempt?.requestId);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM tour_closure_requests')).rows[0].n,1);
  const closedSaleId=randomUUID(),closedSale={...sale,syncSaleId:closedSaleId};
  const blocked=await post(b.token,'sales',{operationId:randomUUID(),saleId:closedSaleId,version:1,recordedAt:at,sale:closedSale,refund:0});assert.equal(blocked.status,409);assert.equal(((await blocked.json()) as {code:string}).code,'TOUR_DAY_CLOSED');
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int n FROM identified_sale_events WHERE sale_id=$1',[closedSaleId])).rows[0].n,0);
  const unauthorized=await fetch(`${origin}/admin/${second.id}/reopen`,{method:'POST',headers:headers(b.token),body:JSON.stringify({requestId:randomUUID(),day:closedDay,expectedVersion:1})});assert.equal(unauthorized.status,401);
  assert.deepEqual(await controller.refreshDay(closedDay),{status:'closed',version:1});
  const reopen=await fetch(`${origin}/admin/${second.id}/reopen`,{method:'POST',headers:{...headers('admin-test'),Authorization:'Bearer admin-test'},body:JSON.stringify({requestId:randomUUID(),day:closedDay,expectedVersion:1})});assert.equal(reopen.status,201);
  assert.deepEqual(await controller.refreshDay(closedDay),{status:'open',version:2});assert.equal(await transaction(()=>findTourCloseAttempt(tx,identity.commercialId,closedDay)),null);
  await transaction(()=>assertLocalTourWritable(tx,identity.commercialId,closedDay));

  // Une modification faite par le premier appareil après le téléchargement
  // ne doit jamais être écrasée ; l'avoir du second reste dans sa file.
  const sale3Id=randomUUID(),sale3={...sale,syncSaleId:sale3Id};
  assert.equal((await post(a.token,'sales',{operationId:randomUUID(),saleId:sale3Id,version:1,recordedAt:at,sale:sale3,refund:0})).status,201);
  const ref3=await get('reference');await transaction(()=>saveVerifiedCreditReference(tx,identity,identity,ref3,digest));
  const source3=await get(`credit-sources/${clientId}`);await transaction(()=>saveCreditSourcesPrototype(tx,identity,identity,clientId,source3,digest));
  const cmd3={operationId:randomUUID(),invoiceId:sale3Id,expectedVersion:1,recordedAt:'2026-11-08T11:00:00.000Z',choice:'refund' as const};
  const review3=await transaction(()=>previewLocalCredit(tx,identity,clientId,'sale',{...cmd3,operationId:randomUUID()},digest));await transaction(()=>confirmLocalCreditReview(tx,identity,review3,cmd3,digest));
  const updated={...sale3,syncVersion:2,lines:[{...sale3.lines[0],name:'Autre libellé'}]};
  assert.equal((await post(a.token,'sales',{operationId:randomUUID(),saleId:sale3Id,version:2,recordedAt:'2026-11-08T12:00:00.000Z',sale:updated,refund:0})).status,201);
  await assert.rejects(controller.synchronize(),/Version de facture périmée/);
  assert.equal((await transaction(()=>readAllOfflineCreditPrototype(tx,identity))).filter(x=>x.pending).length,1);
  assert.equal((await transaction(()=>readPrototypeCreditBalance(tx,identity,clientId,digest))).conflict,true);
  const conflictView=await transaction(()=>readCreditClientsPrototype(tx,identity,digest));assert.equal(conflictView.clients[0].balance,null);assert.equal(conflictView.clients[0].saleBlocked,true);assert.equal(conflictView.clients[0].canSettle,false);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM sales').get()?.n,0);

 } finally {if(server)await new Promise<void>(r=>server!.close(()=>r()));mobile.close();firstPhone.close();}
}
