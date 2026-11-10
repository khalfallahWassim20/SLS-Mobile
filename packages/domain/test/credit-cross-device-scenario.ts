import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import express from 'express';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {identifiedCommercialRoutes,identifiedAdminRoutes} from '../../../apps/api/src/identified-tour-routes.js';
import {identifiedDeviceSchema,assertKnownDeviceEntity} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema,findTourCloseAttempt,acknowledgeTourClose,observeVerifiedTourState,assertLocalTourWritable} from '../../../apps/mobile/tour-close-queue.js';
import {preparePrototypeClose} from '../../../apps/mobile/credit-note-close-prototype.js';
import {offlineCreditPrototypeSchema,readReadyOfflineCreditPrototype,readAllOfflineCreditPrototype,acknowledgeOfflineCreditPrototype,type Note} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {creditReferencePrototypeSchema} from '../../../apps/mobile/credit-note-reference-cache-prototype.js';
import {creditSourcesPrototypeSchema,saveCreditSourcesPrototype,readCreditSourcesPrototype} from '../../../apps/mobile/credit-note-sources-prototype.js';
import {saveVerifiedCreditReference} from '../../../apps/mobile/credit-note-sync-reference.js';
import {readPrototypeCreditBalance} from '../../../apps/mobile/credit-note-balance-storage-prototype.js';
import {previewLocalCredit,confirmLocalCreditReview} from '../../../apps/mobile/credit-note-review-prototype.js';
import {readIdentifiedOutbox,acknowledgeIdentifiedOutbox} from '../../../apps/mobile/identified-outbox.js';
import {uploadIdentifiedOperations,ClosedDaySyncError,OperationConflictSyncError} from '../../../apps/mobile/identified-upload.js';
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
import {readLegacyRows} from '../../../apps/mobile/legacy-read-guard.js';
import {readCreditMobileWorkspacePrototype} from '../../../apps/mobile/credit-mobile-workspace-reader-prototype.js';
import {shareCreditJournalPrototype} from '../../../apps/mobile/credit-note-share-prototype.js';
import {remoteSaleConfirmPrototypeSchema,confirmRemoteSaleEditPrototype,readRemoteEditBalancePrototype,readRemoteEditQueuePrototype,acknowledgeRemoteEditPrototype,finalizeRemoteEditReferencePrototype,readPendingRemoteEditPrototype,recordRemoteEditFailurePrototype,readRemoteAbandonCandidatePrototype,resolveRemoteAbandonPrototype} from '../../../apps/mobile/credit-remote-sale-confirm-prototype.js';
import {remoteSaleDraftPrototypeSchema,stageRemoteSaleEditDraftPrototype} from '../../../apps/mobile/credit-remote-sale-draft-prototype.js';
import {captureRemoteSaleEditPrototype,previewRemoteSaleEditPrototype} from '../../../apps/mobile/credit-remote-sale-edit-prototype.js';
import {readCreditHistoryPrototype} from '../../../apps/mobile/credit-history-prototype.js';
import {prepareCreditSale,prepareCreditSettlement} from '../../../apps/mobile/credit-sale-settlement-prototype.js';

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
  mobile.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE sale_revisions(id INTEGER PRIMARY KEY,sale_id INTEGER,created_at TEXT,previous_payload TEXT,new_payload TEXT,refund INTEGER);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
   CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT PRIMARY KEY,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT PRIMARY KEY,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);
   CREATE TABLE journal_sync_state(invoice_id TEXT PRIMARY KEY,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,version INTEGER,payload TEXT);
   ${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}${creditSourcesPrototypeSchema}${remoteSaleDraftPrototypeSchema}${remoteSaleConfirmPrototypeSchema}`);
  const tx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>mobile.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>mobile.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{mobile.prepare(sql).run(...args)}};
  const transaction=async<T>(action:()=>Promise<T>)=>{mobile.exec('BEGIN');try{const v=await action();mobile.exec('COMMIT');return v;}catch(e){mobile.exec('ROLLBACK');throw e;}};
  const digest=async(text:string)=>createHash('sha256').update(text).digest('hex');mobile.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(second.id,identity.serverOrigin);
  assert.deepEqual(await transaction(()=>readLegacyRows(tx,'SELECT payload FROM sales')),[]);
  const reference=await get('reference');
  // Un nouveau téléphone peut se lier directement en v5, sans créer de
  // référence v3 qui ignorerait les avoirs. Tout échec annule aussi la liaison.
  mobile.exec('DELETE FROM identified_device');
  await assert.rejects(transaction(()=>bindAndCacheCreditReferencePrototype(tx,identity,identity,{...reference,version:3},digest,()=>{})),/Référence/);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM identified_device').get()?.n,0);
  await assert.rejects(transaction(()=>bindAndCacheCreditReferencePrototype(tx,identity,{...identity,commercialId:randomUUID()},reference,digest,()=>{})),/Session/);
  mobile.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(randomUUID(),saleId,1,'{}');
  await assert.rejects(transaction(()=>bindAndCacheCreditReferencePrototype(tx,identity,identity,reference,digest,()=>{})),/opérations en attente/);mobile.exec('DELETE FROM sales_outbox');
  // Un téléphone déjà lié en v3 ne peut pas basculer pendant un envoi
  // antérieur ; sa file et son identité sont conservées.
  mobile.prepare('INSERT INTO identified_device VALUES(1,?,?)').run(second.id,identity.serverOrigin);
  mobile.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(randomUUID(),saleId,1,'{}');
  await assert.rejects(transaction(()=>bindAndCacheCreditReferencePrototype(tx,identity,identity,reference,digest,()=>{})),/opérations en attente/);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM sales_outbox').get()?.n,1);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM credit_reference_prototype_cache').get()?.n,0);
  mobile.exec('DELETE FROM sales_outbox;DELETE FROM identified_device');
  let checks=0;await assert.rejects(transaction(()=>bindAndCacheCreditReferencePrototype(tx,identity,identity,reference,digest,()=>{if(++checks===2)throw Error('session expirée');})),/session expirée/);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM identified_device').get()?.n,0);
  await transaction(()=>bindAndCacheCreditReferencePrototype(tx,identity,identity,reference,digest,()=>{}));
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM identified_device').get()?.n,1);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM identified_reference_cache').get()?.n,0);
  // Une reconnexion v5 ne doit pas effacer ni bloquer ses propres files.
  mobile.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(randomUUID(),saleId,1,'{}');
  await transaction(()=>bindAndCacheCreditReferencePrototype(tx,identity,identity,reference,digest,()=>{}));
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM sales_outbox').get()?.n,1);mobile.exec('DELETE FROM sales_outbox');
  await transaction(()=>saveVerifiedCreditReference(tx,identity,identity,reference,digest));
  const sources=await get(`credit-sources/${clientId}`);await transaction(()=>saveCreditSourcesPrototype(tx,identity,identity,clientId,sources,digest));
  // Aperçu expérimental d'une modification distante : aucune copie locale ni
  // opération en file ; la facture, le solde et le jour sont revérifiés.
  const remoteItem=sources.items.find((x:{kind:string})=>x.kind==='sale');
  const remoteKey={clientId,invoiceId:saleId,version:remoteItem.version,hash:remoteItem.hash},remoteContext={identity,expectedBalance:1019000},editAt='2026-11-08T11:00:00.000Z';
  const captured=await transaction(()=>captureRemoteSaleEditPrototype(tx,remoteContext,remoteKey,editAt,digest));assert.equal(captured.sale.syncSaleId,saleId);assert.equal(captured.sale.paid,50000);
  const editedLines=[{...captured.sale.lines[0],discount:6000}];
  await assert.rejects(transaction(()=>previewRemoteSaleEditPrototype(tx,remoteContext,remoteKey,editAt,editedLines,undefined,digest)),/Choisissez/);
  const refundPreview=await transaction(()=>previewRemoteSaleEditPrototype(tx,remoteContext,remoteKey,editAt,editedLines,'refund',digest));assert.equal(refundPreview.updated.total,47600);assert.equal(refundPreview.refund,2400);assert.equal(refundPreview.balanceAfter,950000);
  const creditPreview=await transaction(()=>previewRemoteSaleEditPrototype(tx,remoteContext,remoteKey,editAt,editedLines,'credit',digest));assert.equal(creditPreview.credit,2400);assert.equal(creditPreview.balanceAfter,947600);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM sales').get()?.n,0);assert.equal(mobile.prepare('SELECT count(*) AS n FROM sales_outbox').get()?.n,0);
  const draftRequest={operationId:randomUUID(),context:remoteContext,key:remoteKey,recordedAt:editAt,lines:editedLines,choice:'refund' as const,preview:refundPreview};
  await assert.rejects(transaction(async()=>{await stageRemoteSaleEditDraftPrototype(tx,draftRequest,digest);throw Error('panne avant commit');}),/panne avant commit/);assert.equal(mobile.prepare('SELECT count(*) AS n FROM credit_remote_sale_draft_prototype').get()?.n,0);
  const staged=await transaction(()=>stageRemoteSaleEditDraftPrototype(tx,draftRequest,digest));assert.equal(staged.status,'draft-only');assert.equal(staged.replayed,false);
  assert.equal((await transaction(()=>stageRemoteSaleEditDraftPrototype(tx,draftRequest,digest))).replayed,true);
  await assert.rejects(transaction(()=>stageRemoteSaleEditDraftPrototype(tx,{...draftRequest,choice:'credit'},digest)),/déjà utilisé/);
  await assert.rejects(transaction(()=>stageRemoteSaleEditDraftPrototype(tx,{...draftRequest,operationId:randomUUID()},digest)),/brouillon existe/);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM credit_remote_sale_draft_prototype').get()?.n,1);assert.equal(mobile.prepare('SELECT count(*) AS n FROM sales').get()?.n,0);assert.equal(mobile.prepare('SELECT count(*) AS n FROM sales_outbox').get()?.n,0);
  assert.deepEqual(await transaction(()=>readPrototypeCreditBalance(tx,identity,clientId,digest)),{balance:1019000,conflict:false});
  await assert.rejects(transaction(async()=>{await confirmRemoteSaleEditPrototype(tx,draftRequest,digest);throw Error('panne avant confirmation');}),/panne avant confirmation/);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM credit_remote_sale_confirm_prototype').get()?.n,0);
  const confirmed=await transaction(()=>confirmRemoteSaleEditPrototype(tx,draftRequest,digest));assert.equal(confirmed.replayed,false);
  assert.equal((await transaction(()=>confirmRemoteSaleEditPrototype(tx,draftRequest,digest))).replayed,true);
  await assert.rejects(transaction(()=>confirmRemoteSaleEditPrototype(tx,{...draftRequest,choice:'credit'},digest)),/autre contenu/);
  assert.deepEqual(await transaction(()=>readRemoteEditBalancePrototype(tx,identity,clientId,digest)),{balance:950000,conflict:false});
  // La file et le solde actifs restent intacts : le registre n'est pas activé.
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM sales_outbox').get()?.n,0);assert.equal((await transaction(()=>readPrototypeCreditBalance(tx,identity,clientId,digest))).conflict,true);
  assert.equal((await transaction(()=>readPrototypeCreditBalance(tx,identity,client2,digest))).conflict,false);
  await transaction(()=>assertCreditWritePrototype(tx,{identity,expectedBalance:0},{kind:'sale',clientId:client2},digest));
  await assert.rejects(transaction(()=>assertCreditWritePrototype(tx,remoteContext,{kind:'edit',clientId},digest)),/conflit/);
  await assert.rejects(transaction(()=>readCreditJournalExportPrototype(tx,identity,day,'Deuxième',digest)),/Journal indisponible/);
  await assert.rejects(transaction(()=>preparePrototypeClose(tx,identity,day,0,randomUUID)),/modification distante/);
  mobile.prepare('INSERT INTO sales(client_id,payload) VALUES(?,?)').run(clientId,JSON.stringify(sale));
  assert.equal((await transaction(()=>readRemoteEditBalancePrototype(tx,identity,clientId,digest))).conflict,true);mobile.exec('DELETE FROM sales');
  mobile.exec('SAVEPOINT tamper_remote_edit');mobile.prepare('UPDATE credit_remote_sale_confirm_prototype SET revised=?').run('{}');
  await assert.rejects(readRemoteEditBalancePrototype(tx,identity,clientId,digest),/illisible|incohérente/);mobile.exec('ROLLBACK TO tamper_remote_edit; RELEASE tamper_remote_edit');
  const [remoteQueue]=await transaction(()=>readRemoteEditQueuePrototype(tx,identity));assert.equal(remoteQueue.operationId,draftRequest.operationId);
  const waitingDetail=await transaction(()=>readPendingRemoteEditPrototype(tx,identity));assert.equal(waitingDetail?.clientName,'Client fictif');assert.equal(waitingDetail?.status,'awaiting-upload');assert.equal(waitingDetail?.newTotal,47600);assert.equal(waitingDetail?.refund,2400);
  await transaction(()=>recordRemoteEditFailurePrototype(tx,identity,remoteQueue,new Error('connexion perdue')));assert.equal((await transaction(()=>readPendingRemoteEditPrototype(tx,identity)))?.failure,null);
  await transaction(()=>recordRemoteEditFailurePrototype(tx,identity,remoteQueue,new ClosedDaySyncError(day,first.id)));
  assert.deepEqual((await transaction(()=>readPendingRemoteEditPrototype(tx,identity)))?.failure,{reason:'closed',day,commercialId:first.id});
  await transaction(()=>recordRemoteEditFailurePrototype(tx,identity,remoteQueue,new OperationConflictSyncError('conflit')));
  assert.deepEqual((await transaction(()=>readPendingRemoteEditPrototype(tx,identity)))?.failure,{reason:'conflict',day:null,commercialId:null});

  await assert.rejects(transaction(()=>acknowledgeRemoteEditPrototype(tx,identity,{...remoteQueue,payload:'{}'})),/incohérent/);
  assert.equal((await transaction(()=>readRemoteEditQueuePrototype(tx,identity))).length,1);
  const savedRef=mobile.prepare('SELECT payload FROM credit_reference_prototype_cache WHERE id=1').get()!.payload as string,advancedRef=JSON.parse(savedRef);
  advancedRef.saleStates.find((v:{saleId:string})=>v.saleId===saleId).version=2;advancedRef.eligibleSaleProofs.find((v:{saleId:string})=>v.saleId===saleId).version=2;
  mobile.prepare('UPDATE credit_reference_prototype_cache SET payload=? WHERE id=1').run(JSON.stringify(advancedRef));
  assert.equal((await transaction(()=>readRemoteEditBalancePrototype(tx,identity,clientId,digest))).conflict,true);
  mobile.prepare('UPDATE credit_reference_prototype_cache SET payload=? WHERE id=1').run(savedRef);
  await transaction(()=>acknowledgeRemoteEditPrototype(tx,identity,remoteQueue));assert.equal((await transaction(()=>readRemoteEditQueuePrototype(tx,identity))).length,0);assert.equal((await transaction(()=>readPendingRemoteEditPrototype(tx,identity)))?.status,'awaiting-reference');assert.equal((await transaction(()=>readPendingRemoteEditPrototype(tx,identity)))?.failure,null);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM credit_remote_sale_confirm_prototype').get()?.n,1);
  mobile.exec('DELETE FROM credit_remote_sale_confirm_prototype;DELETE FROM credit_remote_sale_draft_prototype');
  await assert.rejects(transaction(()=>stageRemoteSaleEditDraftPrototype(tx,{...draftRequest,preview:{...refundPreview,balanceAfter:1}},digest)),/Aperçu modifié/);
  await assert.rejects(transaction(()=>stageRemoteSaleEditDraftPrototype(tx,{...draftRequest,context:{...remoteContext,expectedBalance:1}},digest)),/Solde modifié/);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM credit_remote_sale_draft_prototype').get()?.n,0);

  await assert.rejects(transaction(()=>captureRemoteSaleEditPrototype(tx,{...remoteContext,expectedBalance:1},remoteKey,editAt,digest)),/Solde modifié/);
  await assert.rejects(transaction(()=>captureRemoteSaleEditPrototype(tx,remoteContext,{...remoteKey,version:2},editAt,digest)),/périmée/);
  await assert.rejects(transaction(()=>captureRemoteSaleEditPrototype(tx,remoteContext,remoteKey,'2026-11-07T10:00:00.000Z',digest)),/antérieure/);
  mobile.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(randomUUID(),saleId,2,'{}');
  await assert.rejects(transaction(()=>captureRemoteSaleEditPrototype(tx,remoteContext,remoteKey,editAt,digest)),/en attente/);mobile.exec('DELETE FROM sales_outbox');
  await assert.rejects(transaction(()=>captureRemoteSaleEditPrototype(tx,{...remoteContext,identity:{...identity,serverOrigin:'https://wrong.example.test'}},remoteKey,editAt,digest)),/Identité|identité/);
  const cachedSources=mobile.prepare('SELECT payload FROM credit_sources_prototype_cache WHERE client_id=?').get(clientId)!.payload as string,alteredSources=JSON.parse(cachedSources);
  alteredSources.items.find((x:{kind:string})=>x.kind==='sale').source.paid=1;
  mobile.prepare('UPDATE credit_sources_prototype_cache SET payload=? WHERE client_id=?').run(JSON.stringify(alteredSources),clientId);
  await assert.rejects(transaction(()=>captureRemoteSaleEditPrototype(tx,remoteContext,remoteKey,editAt,digest)),/Source de vente non confirmée|Empreinte/);
  mobile.prepare('UPDATE credit_sources_prototype_cache SET payload=? WHERE client_id=?').run(cachedSources,clientId);
  mobile.prepare('INSERT INTO sales(client_id,payload) VALUES(?,?)').run(clientId,JSON.stringify(sale));
  await assert.rejects(transaction(()=>captureRemoteSaleEditPrototype(tx,remoteContext,remoteKey,editAt,digest)),/Vente locale/);mobile.exec('DELETE FROM sales');
  mobile.prepare("INSERT INTO tour_known_server_states(commercial_id,journal_date,status,version) VALUES(?,?,'closed',1)").run(identity.commercialId,day);
  await assert.rejects(transaction(()=>captureRemoteSaleEditPrototype(tx,remoteContext,remoteKey,editAt,digest)),/clôturée/);mobile.exec('DELETE FROM tour_known_server_states');

  // Anciennes factures déjà présentes sur ce téléphone mais sans marqueur
  // local : leur source exacte et leur version peuvent être prouvées par v5,
  // même hors ligne et sans cache de sources distantes.
  const journalSourceBefore=sources.items.find((x:{kind:string})=>x.kind==='preinvoice').source;
  mobile.prepare('INSERT INTO sales(client_id,payload) VALUES(?,?)').run(clientId,JSON.stringify(sale));
  mobile.prepare('INSERT INTO tour_pre_invoices(id,client_id,journal_date,payload) VALUES(?,?,?,?)').run(invoiceId,clientId,day,JSON.stringify(invoice));
  mobile.prepare('INSERT INTO tour_journal_receipts(id,pre_invoice_id,client_id,journal_date,payload) VALUES(?,?,?,?,?)').run(receipt.id,invoiceId,clientId,day,JSON.stringify(receipt));
  mobile.prepare('INSERT INTO journal_sync_state(invoice_id,version,payload) VALUES(?,?,?)').run(invoiceId,2,JSON.stringify(journalSourceBefore));
  mobile.exec('DELETE FROM credit_sources_prototype_cache');
  const historical=await transaction(()=>readCreditSourceChoices(tx,identity,clientId,digest));
  assert.equal(historical.remoteAvailable,false);assert.equal(historical.items.length,2);assert.ok(historical.items.every(x=>x.origin==='local'&&!x.blocked));
  const historicPreview=await transaction(()=>previewLocalCredit(tx,identity,clientId,'sale',{operationId:randomUUID(),invoiceId:saleId,expectedVersion:1,recordedAt:'2026-11-08T11:00:00.000Z',choice:'refund'},digest));
  assert.equal(historicPreview.afterBalance,950000);assert.equal(mobile.prepare('SELECT count(*) AS n FROM offline_credit_prototype').get()?.n,0);
  const historicPre=await transaction(()=>previewLocalCredit(tx,identity,clientId,'preinvoice',{operationId:randomUUID(),invoiceId,expectedVersion:2,recordedAt:'2026-11-08T11:00:00.000Z',choice:'credit'},digest));
  assert.equal(historicPre.afterBalance,419000);assert.equal(historicPre.retainedCredit,250000);
  const historicalCache=mobile.prepare('SELECT payload FROM credit_reference_prototype_cache WHERE id=1').get()!.payload as string,withoutEligible=JSON.parse(historicalCache);
  withoutEligible.eligibleSaleProofs=withoutEligible.eligibleSaleProofs.filter((x:{saleId:string})=>x.saleId!==saleId);
  mobile.prepare('UPDATE credit_reference_prototype_cache SET payload=?').run(JSON.stringify(withoutEligible));
  const missingProof=await transaction(()=>readCreditSourceChoices(tx,identity,clientId,digest));assert.equal(missingProof.items.find(x=>x.kind==='sale')?.blocked,'rapprochement');
  mobile.prepare('UPDATE credit_reference_prototype_cache SET payload=?').run(historicalCache);
  mobile.prepare('UPDATE sales SET payload=?').run(JSON.stringify({...sale,clientName:'Altéré'}));
  const changedHistorical=await transaction(()=>readCreditSourceChoices(tx,identity,clientId,digest));assert.equal(changedHistorical.items.find(x=>x.kind==='sale')?.blocked,'rapprochement');
  mobile.prepare('UPDATE sales SET payload=?').run(JSON.stringify(sale));
  mobile.prepare('INSERT INTO journal_sync_outbox(operation_id,invoice_id,version,payload) VALUES(?,?,?,?)').run(randomUUID(),invoiceId,2,'{}');
  const pendingHistorical=await transaction(()=>readCreditSourceChoices(tx,identity,clientId,digest));assert.equal(pendingHistorical.items.find(x=>x.kind==='preinvoice')?.blocked,'rapprochement');
  mobile.exec('DELETE FROM sales;DELETE FROM tour_journal_receipts;DELETE FROM tour_pre_invoices;DELETE FROM journal_sync_state;DELETE FROM journal_sync_outbox');
  await transaction(()=>saveCreditSourcesPrototype(tx,identity,identity,clientId,sources,digest));
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
  const localHistory=await transaction(()=>readCreditHistoryPrototype(tx,identity,clientId,digest));assert.equal(localHistory.sales.length,1);assert.equal(localHistory.sales[0].sale.syncSaleId,localSaleId);assert.equal(localHistory.receipts.length,1);assert.equal(localHistory.receipts[0].oldDebtPaid,400000);
  mobile.prepare('UPDATE tour_journal_receipts SET payload=? WHERE id=?').run(JSON.stringify({...localReceipt,oldDebtPaid:1}),localReceipt.id);await assert.rejects(transaction(()=>readCreditSourceChoices(tx,identity,clientId,digest)),/Historique local/);mobile.prepare('UPDATE tour_journal_receipts SET payload=? WHERE id=?').run(JSON.stringify(localReceipt),localReceipt.id);
  await transaction(()=>saveCreditSourcesPrototype(tx,identity,identity,clientId,sources,digest));
  assert.equal((await transaction(()=>readCreditSourceChoices(tx,identity,clientId,digest))).items.length,4);
  const mixedHistory=await transaction(()=>readCreditHistoryPrototype(tx,identity,clientId,digest));assert.equal(mixedHistory.remoteAvailable,true);assert.equal(mixedHistory.remoteSales.length,1);assert.equal(mixedHistory.remoteSales[0].invoiceId,saleId);assert.equal(mixedHistory.remoteSales[0].total,119000);assert.equal(mixedHistory.sales.length,1);assert.equal(mixedHistory.articles[0].code,'ART-TEST');
  mobile.exec('DELETE FROM sales;DELETE FROM sales_outbox;DELETE FROM tour_journal_receipts;DELETE FROM tour_pre_invoices;DELETE FROM journal_sync_state;DELETE FROM identified_local_operations');
  // Dès la liaison v5, aucune écriture v3 ne doit utiliser un calcul ancien,
  // même avant le premier avoir. Les sources historiques sont vérifiées sur
  // les preuves v5 et ne nécessitent pas de cache v3 sur le téléphone.
  await assert.rejects(transaction(()=>assertLegacyMobileCreditSafe(tx,identity)),/Téléphone lié en v5/);
  await assert.rejects(transaction(()=>readLegacyRows(tx,'SELECT payload FROM sales')),/Téléphone lié en v5/);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM credit_reference_prototype_cache').get()?.n,1);
  const saleProof={clientId,version:1,total:sale.total,paid:sale.paid,payload:JSON.stringify(sale),digest};
  const journalSource=sources.items.find((x:{kind:string})=>x.kind==='preinvoice').source;
  const journalProof={version:2,payload:JSON.stringify(journalSource),digest};
  await transaction(()=>assertKnownDeviceEntity(tx,identity,'sale',saleId,saleProof,undefined,true));
  await transaction(()=>assertKnownDeviceEntity(tx,identity,'journal',invoiceId,undefined,journalProof,true));
  await assert.rejects(transaction(()=>assertKnownDeviceEntity(tx,identity,'sale',saleId,{...saleProof,payload:JSON.stringify({...sale,clientName:'altéré'})},undefined,true)),/rapprochement/);
  await assert.rejects(transaction(()=>assertKnownDeviceEntity(tx,identity,'sale',saleId,{...saleProof,version:2},undefined,true)),/rapprochement/);
  await assert.rejects(transaction(()=>assertKnownDeviceEntity(tx,identity,'journal',invoiceId,undefined,{...journalProof,payload:JSON.stringify({...journalSource,receipts:[]})},true)),/rapprochement/);
  await assert.rejects(transaction(()=>assertKnownDeviceEntity(tx,{...identity,serverOrigin:'https://autre.example.test'},'sale',saleId,saleProof,undefined,true)),/rapprochement/);
  // La future écriture v5 vérifie le même solde dans la transaction, sans
  // traiter une limite de zéro comme blocage.
  const context={identity,expectedBalance:1019000};
  assert.equal((await transaction(()=>assertCreditWritePrototype(tx,context,{kind:'sale',clientId},digest))).balance,1019000);
  const initialView=await transaction(()=>readCreditClientsPrototype(tx,identity,digest));assert.equal(initialView.version,5);assert.equal(initialView.clients[0].balance,1019000);assert.equal(initialView.clients[0].saleBlocked,false);assert.equal(initialView.pendingCredits,0);assert.equal(initialView.articles[0].saleTtc,'60000');assert.equal('purchaseTtc' in initialView.articles[0],false);
  // Les futurs formulaires reprennent le solde capturé, puis l'écriture doit
  // revérifier ce contexte dans SQLite, y compris après un changement de solde.
  const formClient=initialView.clients.find(c=>c.id===clientId)!;
  const payment={mode:'Espèces' as const,paid:'50',chequeNumber:'',chequeBank:'',chequeDue:''};
  const formSale=prepareCreditSale(formClient,context,[{article:initialView.articles[0],quantity:2,discount:0}],payment,at);
  assert.equal(formSale.total,120000);assert.equal(formSale.remaining,70000);
  const formSettlement=prepareCreditSettlement(formClient,context,payment,at);assert.equal(formSettlement.amount,50000);
  await transaction(()=>assertCreditWritePrototype(tx,context,{kind:'sale',clientId:formSale.clientId},digest));
  await transaction(()=>assertCreditWritePrototype(tx,context,{kind:'settlement',clientId:formSettlement.clientId,amount:formSettlement.amount},digest));
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
  await assert.rejects(transaction(()=>captureRemoteSaleEditPrototype(tx,{identity,expectedBalance:950000},remoteKey,editAt,digest)),/annulée/);
  await assert.rejects(transaction(()=>assertLegacyMobileCreditSafe(tx,identity)),/Des avoirs existent/);
  assert.equal((await transaction(()=>assertCreditWritePrototype(tx,{identity,expectedBalance:950000},{kind:'sale',clientId},digest))).balance,950000);
  const preReview=await transaction(()=>previewLocalCredit(tx,identity,clientId,'preinvoice',{...preCommand,operationId:randomUUID()},digest));assert.equal(preReview.afterBalance,350000);
  await transaction(()=>confirmLocalCreditReview(tx,identity,preReview,preCommand,digest));
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM sales').get()?.n,0);assert.equal(mobile.prepare('SELECT count(*) AS n FROM tour_pre_invoices').get()?.n,0);
  assert.deepEqual(await transaction(()=>readPrototypeCreditBalance(tx,identity,clientId,digest)),{balance:350000,conflict:false});
  const preparedView=await transaction(()=>readCreditClientsPrototype(tx,identity,digest));assert.equal(preparedView.clients[0].balance,350000);assert.equal(preparedView.pendingCredits,2);assert.equal(preparedView.pendingOperations,0);
  const exportBefore=await transaction(()=>readCreditJournalExportPrototype(tx,identity,day,'Deuxième',digest));
  const workspace=await transaction(()=>readCreditMobileWorkspacePrototype(tx,identity,day,'Deuxième',digest));assert.equal(workspace.clients.clients[0].balance,350000);assert.equal(workspace.clients.pendingCredits,2);assert.equal(workspace.view.totals.creditNotes,719000);
  const exportModel=describeCreditJournalPrototype(exportBefore);assert.equal(exportModel.totals.creditNotes,719000);assert.equal(exportModel.totals.refunds,50000);assert.equal(exportModel.totals.retainedCredit,250000);assert.equal(exportModel.totals.billedAfterLocalCredits,-719000);
  // Les exports proviennent de la même capture que le modèle et ne nécessitent
  // aucun réseau ; PDF et CSV restent disponibles en attente de synchronisation.
  const writes:{uri:string;content:string;encoding:string}[]=[],shares:string[]=[];
  const shareIO={cacheDirectory:'file:///cache/',available:async()=>true,write:async(uri:string,content:string,encoding:'utf8'|'base64')=>{writes.push({uri,content,encoding});},print:async(html:string)=>{assert.match(html,/Avoir/);return {base64:'UEZG'};},share:async(uri:string)=>{shares.push(uri);},now:()=>1};
  await shareCreditJournalPrototype(workspace.journal,'csv',shareIO);await shareCreditJournalPrototype(workspace.journal,'pdf',shareIO);
  assert.equal(writes.length,2);assert.match(writes[0].content,/719,000/);assert.equal(writes[1].encoding,'base64');assert.equal(shares.length,2);
  await assert.rejects(shareCreditJournalPrototype({...workspace.journal,credits:undefined},'csv',shareIO),/v5 invalide/);
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
  await assert.rejects(transaction(()=>assertKnownDeviceEntity(tx,identity,'sale',saleId,saleProof,undefined,true)),/rapprochement/);
  await assert.rejects(transaction(()=>assertKnownDeviceEntity(tx,identity,'journal',invoiceId,undefined,journalProof,true)),/rapprochement/);
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

  // Protocole serveur réel : un autre commercial peut modifier la facture,
  // sans la réattribuer à son propre journal ; reprise et clôture d'origine.
  const otherDay='2026-11-07',otherAt='2026-11-07T09:00:00.000Z',otherSaleId=randomUUID();
  const otherSale={...sale,createdAt:otherAt,clientId:client2,clientName:'Z Client fictif',syncSaleId:otherSaleId};
  assert.equal((await post(a.token,'sales',{operationId:randomUUID(),saleId:otherSaleId,version:1,recordedAt:otherAt,sale:otherSale,refund:0})).status,201);
  const remoteModified={...otherSale,syncVersion:2,lines:[{...otherSale.lines[0],discount:6000}],total:47600,paid:47600,remaining:0};
  const remoteEvent={operationId:randomUUID(),saleId:otherSaleId,version:2,recordedAt:'2026-11-07T10:00:00.000Z',sale:remoteModified,refund:2400};
  // Un troisième SQLite isolé prépare, confirme et envoie la révision distante.
  // Une réponse perdue est reprise avec le même UUID ; seule une référence
  // finale prouvant la nouvelle version permet de terminer l'essai.
  const isolated=new DatabaseSync(':memory:');
  try{
   isolated.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
   CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT PRIMARY KEY,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT PRIMARY KEY,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);
   CREATE TABLE journal_sync_state(invoice_id TEXT PRIMARY KEY,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,version INTEGER,payload TEXT);
   ${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}${creditSourcesPrototypeSchema}${remoteSaleDraftPrototypeSchema}${remoteSaleConfirmPrototypeSchema}`);
   const isolatedTx={getFirstAsync:async<T>(sql:string,...args:(string|number|null)[])=>isolated.prepare(sql).get(...args) as T||null,getAllAsync:async<T>(sql:string,...args:(string|number|null)[])=>isolated.prepare(sql).all(...args) as T[],runAsync:async(sql:string,...args:(string|number|null)[])=>{isolated.prepare(sql).run(...args)}};
   const isolatedTransaction=async<T>(fn:()=>Promise<T>)=>{isolated.exec('BEGIN');try{const v=await fn();isolated.exec('COMMIT');return v;}catch(e){isolated.exec('ROLLBACK');throw e;}};
   const referenceBeforeEdit=await get('reference');await isolatedTransaction(()=>bindAndCacheCreditReferencePrototype(isolatedTx,identity,identity,referenceBeforeEdit,digest,()=>{}));
   const remoteSources=await get(`credit-sources/${client2}`);await isolatedTransaction(()=>saveCreditSourcesPrototype(isolatedTx,identity,identity,client2,remoteSources,digest));
   const remoteSource=remoteSources.items.find((x:{kind:string;invoiceId:string})=>x.kind==='sale'&&x.invoiceId===otherSaleId);
   const key={clientId:client2,invoiceId:otherSaleId,version:remoteSource.version,hash:remoteSource.hash},context2={identity,expectedBalance:69000};
   const cap=await isolatedTransaction(()=>captureRemoteSaleEditPrototype(isolatedTx,context2,key,remoteEvent.recordedAt,digest));
   const editLines=[{...cap.sale.lines[0],discount:6000}];
   const preview=await isolatedTransaction(()=>previewRemoteSaleEditPrototype(isolatedTx,context2,key,remoteEvent.recordedAt,editLines,'refund',digest));
   assert.equal(preview.balanceAfter,0);assert.equal(preview.refund,2400);
   const draft={operationId:remoteEvent.operationId,context:context2,key,recordedAt:remoteEvent.recordedAt,lines:editLines,choice:'refund' as const,preview};
   await isolatedTransaction(()=>stageRemoteSaleEditDraftPrototype(isolatedTx,draft,digest));await isolatedTransaction(()=>confirmRemoteSaleEditPrototype(isolatedTx,draft,digest));
   assert.deepEqual(await isolatedTransaction(()=>readRemoteEditBalancePrototype(isolatedTx,identity,client2,digest)),{balance:0,conflict:false});
   // Hors ligne, la révision bloque seulement son client. Un autre client
   // peut encore recevoir une vente, qui sera envoyée après la révision.
   const partialClients=await isolatedTransaction(()=>readCreditClientsPrototype(isolatedTx,identity,digest));
   assert.equal(partialClients.clients.find(c=>c.id===client2)?.balance,null);assert.equal(partialClients.clients.find(c=>c.id===client2)?.conflict,true);
   const otherClient=partialClients.clients.find(c=>c.id===clientId)!;assert.equal(otherClient.conflict,false);assert.notEqual(otherClient.balance,null);
   const otherContext={identity,expectedBalance:otherClient.balance!};await isolatedTransaction(()=>assertCreditWritePrototype(isolatedTx,otherContext,{kind:'sale',clientId},digest));
   await assert.rejects(isolatedTransaction(()=>assertCreditWritePrototype(isolatedTx,context2,{kind:'sale',clientId:client2},digest)),/conflit/);
   await assert.rejects(isolatedTransaction(()=>readCreditJournalExportPrototype(isolatedTx,identity,otherDay,'Deuxième',digest)),/Journal indisponible/);
   const offlineSaleId=randomUUID(),offlineOperation=randomUUID(),offlineSale={...prepareCreditSale(otherClient,otherContext,[{article:partialClients.articles[0],quantity:1,discount:0}],{mode:'Crédit',paid:'0',chequeNumber:'',chequeBank:'',chequeDue:''},otherAt),syncSaleId:offlineSaleId,syncVersion:1};
   isolated.prepare('INSERT INTO sales(client_id,payload) VALUES(?,?)').run(clientId,JSON.stringify(offlineSale));
   isolated.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(offlineOperation,offlineSaleId,1,JSON.stringify({operationId:offlineOperation,saleId:offlineSaleId,version:1,sale:offlineSale,refund:0}));
   isolated.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(offlineOperation,identity.commercialId,'sale',offlineSaleId,otherAt);

   const pending=await isolatedTransaction(()=>readRemoteEditQueuePrototype(isolatedTx,identity));assert.equal(pending.length,1);
   let loseReply=true;const sendEdit=async(path:string,body:string)=>{const response=await fetch(`${origin}/v5/${path}`,{method:'POST',headers:headers(b.token),body});if(loseReply){loseReply=false;assert.equal(response.status,201);throw Error('réponse perdue');}return response;};
   let expireRemoteAck=true,expireRemoteFinal=true;
   const syncIO={
    fetchReference:()=>get('reference'),sendOperation:sendEdit,sendCredit:async()=>{throw Error('avoir inattendu');},
    saveReference:async(id:typeof identity,verified:typeof identity,value:unknown)=>{await isolatedTransaction(()=>saveVerifiedCreditReference(isolatedTx,id,verified,value,digest));},
    saveFinalReference:(id:typeof identity,verified:typeof identity,value:unknown)=>isolatedTransaction(()=>saveAndVerifyFinalCreditReference(isolatedTx,id,verified,value,digest)),
    readOperations:()=>isolatedTransaction(()=>readIdentifiedOutbox(isolatedTx,identity)),acknowledgeOperation:(entry:typeof pending[number])=>isolatedTransaction(()=>acknowledgeIdentifiedOutbox(isolatedTx,identity,entry)),readReadyCredits:async()=>[],readAllCredits:async()=>[],acknowledgeCredit:async()=>{throw Error('avoir inattendu');},
    remoteEdits:{hasPending:async()=>!!isolated.prepare('SELECT EXISTS(SELECT 1 FROM credit_remote_sale_confirm_prototype WHERE acknowledged<2) AS n').get()?.n,
     readQueue:()=>isolatedTransaction(()=>readRemoteEditQueuePrototype(isolatedTx,identity)),
     recordFailure:(entry:typeof pending[number],error:unknown)=>isolatedTransaction(()=>recordRemoteEditFailurePrototype(isolatedTx,identity,entry,error)),
     acknowledge:(entry:typeof pending[number])=>isolatedTransaction(async()=>{await acknowledgeRemoteEditPrototype(isolatedTx,identity,entry);if(expireRemoteAck){expireRemoteAck=false;throw Error('session expirée pendant accusé');}}),
     finalize:(id:typeof identity,verified:typeof identity,value:unknown)=>isolatedTransaction(async()=>{await finalizeRemoteEditReferencePrototype(isolatedTx,id,verified,value,digest);if(expireRemoteFinal){expireRemoteFinal=false;throw Error('session expirée pendant référence finale');}})}
   };
   await assert.rejects(syncCreditPrototype(identity,identity,syncIO),/réponse perdue/);
   assert.equal((await isolatedTransaction(()=>readRemoteEditQueuePrototype(isolatedTx,identity))).length,1);
   const checkNow=Date.now(),checkSession={id:second.id,name:'Deuxième',serverOrigin:identity.serverOrigin,token:b.token,expiresAt:new Date(checkNow+3600000).toISOString()};
   const checkAbandon=createCreditTransportPrototype(checkSession,identity,{now:()=>checkNow,request:(url,opts)=>fetch(url.replace(`${identity.serverOrigin}/api/mobile/identified/`,`${origin}/v5/`),opts),cacheReference:async()=>{},cacheSources:async()=>{},synchronize:async()=>({operations:0,credits:0}),remoteAbandon:{read:()=>isolatedTransaction(()=>readRemoteAbandonCandidatePrototype(isolatedTx,identity)),resolve:async()=>{throw Error('une modification reçue ne doit pas être effacée');}}});
   assert.equal(await checkAbandon.abandonRemoteEdit(),'already-received');
   assert.equal((await isolatedTransaction(()=>readRemoteEditQueuePrototype(isolatedTx,identity))).length,1);

   assert.equal((await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,client2,digest))).conflict,true);
   await assert.rejects(syncCreditPrototype(identity,identity,syncIO),/session expirée pendant accusé/);
   assert.equal((await isolatedTransaction(()=>readRemoteEditQueuePrototype(isolatedTx,identity))).length,1);
   await assert.rejects(syncCreditPrototype(identity,identity,syncIO),/session expirée pendant référence finale/);
   assert.equal((await isolatedTransaction(()=>readRemoteEditQueuePrototype(isolatedTx,identity))).length,0);
   assert.equal(isolated.prepare('SELECT acknowledged FROM credit_remote_sale_confirm_prototype WHERE operation_id=?').get(remoteEvent.operationId)?.acknowledged,1);
   assert.equal((await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,client2,digest))).conflict,true);
   assert.deepEqual(await syncCreditPrototype(identity,identity,syncIO),{operations:1,credits:0});
   assert.equal((await isolatedTransaction(()=>readIdentifiedOutbox(isolatedTx,identity))).length,0);
   assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1',[offlineSaleId])).rows[0].n,1);
   assert.equal((await isolatedTransaction(()=>readRemoteEditQueuePrototype(isolatedTx,identity))).length,0);
   assert.equal(isolated.prepare('SELECT acknowledged FROM credit_remote_sale_confirm_prototype WHERE operation_id=?').get(remoteEvent.operationId)?.acknowledged,2);
   assert.equal(isolated.prepare('SELECT count(*) AS n FROM credit_remote_sale_draft_prototype').get()?.n,0);
   assert.deepEqual(await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,client2,digest)),{balance:0,conflict:false});
   // La preuve de la version reçue libère les soldes et permet une nouvelle
   // révision de la même facture, tout en conservant l'historique de la première.
   const refreshedSources=await get(`credit-sources/${client2}`);await isolatedTransaction(()=>saveCreditSourcesPrototype(isolatedTx,identity,identity,client2,refreshedSources,digest));
   const refreshedItem=refreshedSources.items.find((x:{kind:string;invoiceId:string})=>x.kind==='sale'&&x.invoiceId===otherSaleId);
   const key2={clientId:client2,invoiceId:otherSaleId,version:refreshedItem.version,hash:refreshedItem.hash},context3={identity,expectedBalance:0},nextAt='2026-11-07T11:00:00.000Z';
   const cap2=await isolatedTransaction(()=>captureRemoteSaleEditPrototype(isolatedTx,context3,key2,nextAt,digest));const nextLines=[{...cap2.sale.lines[0],discount:5000}];
   const nextPreview=await isolatedTransaction(()=>previewRemoteSaleEditPrototype(isolatedTx,context3,key2,nextAt,nextLines,undefined,digest));
   const nextDraft={operationId:randomUUID(),context:context3,key:key2,recordedAt:nextAt,lines:nextLines,preview:nextPreview};
   await isolatedTransaction(()=>stageRemoteSaleEditDraftPrototype(isolatedTx,nextDraft,digest));await isolatedTransaction(()=>confirmRemoteSaleEditPrototype(isolatedTx,nextDraft,digest));
   assert.equal(isolated.prepare('SELECT count(*) AS n FROM credit_remote_sale_confirm_prototype').get()?.n,2);
   assert.equal((await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,client2,digest))).conflict,true);
   // Le créateur clôture après la capture hors ligne : refus explicite,
   // conservation du même UUID, puis reprise après réouverture admin.
   assert.equal((await post(a.token,'close',{requestId:randomUUID(),day:otherDay,expectedVersion:0})).status,201);
   await assert.rejects(syncCreditPrototype(identity,identity,syncIO),(e:unknown)=>e instanceof ClosedDaySyncError&&e.day===otherDay&&e.commercialId===first.id);
   const closedDetail=await isolatedTransaction(()=>readPendingRemoteEditPrototype(isolatedTx,identity));
   assert.equal(closedDetail?.operationId,nextDraft.operationId);assert.deepEqual(closedDetail?.failure,{reason:'closed',day:otherDay,commercialId:first.id});
   assert.equal((await isolatedTransaction(()=>readRemoteEditQueuePrototype(isolatedTx,identity))).length,1);
   assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1',[otherSaleId])).rows[0].n,2);
   const reopenOrigin=await fetch(`${origin}/admin/${first.id}/reopen`,{method:'POST',headers:{...headers('admin-test'),Authorization:'Bearer admin-test'},body:JSON.stringify({requestId:randomUUID(),day:otherDay,expectedVersion:1})});assert.equal(reopenOrigin.status,201);
   assert.deepEqual(await syncCreditPrototype(identity,identity,syncIO),{operations:1,credits:0});
   assert.equal(await isolatedTransaction(()=>readPendingRemoteEditPrototype(isolatedTx,identity)),null);
   assert.deepEqual(await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,client2,digest)),{balance:11900,conflict:false});
   // Conflit/abandon : réponse perdue, transaction locale interrompue puis reprise.
   const sources4=await get(`credit-sources/${client2}`);await isolatedTransaction(()=>saveCreditSourcesPrototype(isolatedTx,identity,identity,client2,sources4,digest));
   const item4=sources4.items.find((x:{kind:string;invoiceId:string})=>x.kind==='sale'&&x.invoiceId===otherSaleId);
   const key4={clientId:client2,invoiceId:otherSaleId,version:item4.version,hash:item4.hash},ctx4={identity,expectedBalance:11900},at4='2026-11-07T12:00:00.000Z';
   const cap4=await isolatedTransaction(()=>captureRemoteSaleEditPrototype(isolatedTx,ctx4,key4,at4,digest));const lines4=[{...cap4.sale.lines[0],discount:4000}];
   const preview4=await isolatedTransaction(()=>previewRemoteSaleEditPrototype(isolatedTx,ctx4,key4,at4,lines4,undefined,digest));
   const draft4={operationId:randomUUID(),context:ctx4,key:key4,recordedAt:at4,lines:lines4,preview:preview4};
   await isolatedTransaction(()=>stageRemoteSaleEditDraftPrototype(isolatedTx,draft4,digest));await isolatedTransaction(()=>confirmRemoteSaleEditPrototype(isolatedTx,draft4,digest));
   let loseAbandon=true,rollbackAbandon=true;
   const now=Date.now(),session={id:second.id,name:'Deuxième',serverOrigin:identity.serverOrigin,token:b.token,expiresAt:new Date(now+3600000).toISOString()};
   const abandonTransport=createCreditTransportPrototype(session,identity,{
    now:()=>now,request:async(url,opts)=>{const result=await fetch(url.replace(`${identity.serverOrigin}/api/mobile/identified/`,`${origin}/v5/`),opts);if(url.endsWith('/remote-sale-edits/abandon')&&loseAbandon){loseAbandon=false;throw Error('réponse abandon perdue');}return result;},
    cacheReference:async()=>{},cacheSources:async()=>{},synchronize:async()=>({operations:0,credits:0}),
    remoteAbandon:{read:()=>isolatedTransaction(()=>readRemoteAbandonCandidatePrototype(isolatedTx,identity)),resolve:(id,verified,entry,response,reference)=>isolatedTransaction(async()=>{await resolveRemoteAbandonPrototype(isolatedTx,id,verified,entry,response,reference,digest);if(rollbackAbandon){rollbackAbandon=false;throw Error('session interrompue');}})}
   });
   await assert.rejects(abandonTransport.abandonRemoteEdit(),/réponse abandon perdue/);
   assert.equal((await isolatedTransaction(()=>readRemoteEditQueuePrototype(isolatedTx,identity))).length,1);
   const savedCandidate=await isolatedTransaction(()=>readRemoteAbandonCandidatePrototype(isolatedTx,identity));
   assert.equal((await post(b.token,'sales',savedCandidate.event)).status,409);
   await assert.rejects(abandonTransport.abandonRemoteEdit(),/session interrompue/);
   assert.equal((await isolatedTransaction(()=>readRemoteEditQueuePrototype(isolatedTx,identity))).length,1);
   assert.equal(isolated.prepare('SELECT count(*) AS n FROM credit_remote_sale_abandoned_prototype').get()?.n,0);
   assert.equal(await abandonTransport.abandonRemoteEdit(),'abandoned');
   assert.equal(await isolatedTransaction(()=>readPendingRemoteEditPrototype(isolatedTx,identity)),null);
   assert.deepEqual(await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,client2,digest)),{balance:11900,conflict:false});
   assert.equal(isolated.prepare('SELECT count(*) AS n FROM credit_remote_sale_abandoned_prototype').get()?.n,1);
   await assert.rejects(isolatedTransaction(()=>confirmRemoteSaleEditPrototype(isolatedTx,draft4,digest)),/abandonnée/);
   assert.equal(isolated.prepare('SELECT count(*) AS n FROM credit_remote_sale_confirm_prototype WHERE acknowledged=2').get()?.n,3);
   assert.equal(isolated.prepare('SELECT count(*) AS n FROM sales').get()?.n,1);assert.equal(isolated.prepare('SELECT count(*) AS n FROM sales_outbox').get()?.n,0);
  }finally{isolated.close();}
  assert.equal((await post(b.token,'sales',remoteEvent)).status,200);
  assert.equal((await post(b.token,'sales',{...remoteEvent,operationId:randomUUID()})).status,409);
  const otherVersions=await db.query<{version:number;commercial_id:string}>('SELECT version,commercial_id FROM identified_sale_events WHERE sale_id=$1 ORDER BY version',[otherSaleId]);
  assert.deepEqual(otherVersions.rows.map(x=>[x.version,x.commercial_id]),[[1,first.id],[2,second.id],[3,second.id]]);
  const dayA=await fetch(`${origin}/v5/day/${otherDay}/details`,{headers:headers(a.token)}),dayB=await fetch(`${origin}/v5/day/${otherDay}/details`,{headers:headers(b.token)});
  assert.equal(dayA.status,200);assert.equal(dayB.status,200);
  const aJournal=await dayA.json() as {rows:{clientId:string;tourTotal:number;saleCount:number}[]},bJournal=await dayB.json() as {rows:{clientId:string;saleCount:number}[]};
  assert.equal(aJournal.rows.find(x=>x.clientId===client2)?.tourTotal,59500);assert.equal(aJournal.rows.find(x=>x.clientId===client2)?.saleCount,1);
  assert.equal(bJournal.rows.some(x=>x.clientId===client2&&x.saleCount>0),false);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1',[otherSaleId])).rows[0].n,3);
  // Un abandon côté serveur réserve l'UUID sous le même verrou que l'envoi.
  // Une opération déjà reçue n'est jamais effacée, même si sa réponse s'est perdue.
  const already=await post(b.token,'remote-sale-edits/abandon',remoteEvent);assert.equal(already.status,200);assert.equal((await already.json() as {status:string}).status,'already-received');
  const abandonEvent={operationId:randomUUID(),saleId:otherSaleId,version:4,recordedAt:'2026-11-07T12:00:00.000Z',sale:{...remoteModified,syncVersion:4},refund:0};
  const discarded=await post(b.token,'remote-sale-edits/abandon',abandonEvent);assert.equal(discarded.status,200);assert.equal((await discarded.json() as {status:string}).status,'abandoned');
  const replayDiscard=await post(b.token,'remote-sale-edits/abandon',abandonEvent);assert.equal((await replayDiscard.json() as {status:string}).status,'abandoned');
  assert.equal((await post(b.token,'remote-sale-edits/abandon',{...abandonEvent,refund:1})).status,409);
  assert.equal((await post(a.token,'remote-sale-edits/abandon',abandonEvent)).status,409);
  assert.equal((await post(b.token,'sales',abandonEvent)).status,409);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM remote_sale_abandon_prototype WHERE operation_id=$1',[abandonEvent.operationId])).rows[0].n,1);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1',[otherSaleId])).rows[0].n,3);


 } finally {if(server)await new Promise<void>(r=>server!.close(()=>r()));mobile.close();firstPhone.close();}
}
