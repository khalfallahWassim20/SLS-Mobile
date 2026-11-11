import {readPendingCreditAbandonPrototype,resolveCreditAbandonPrototype} from '../../../apps/mobile/credit-note-abandon-prototype.js';
import {readAbandonedCreditNotesPrototype} from '../../../apps/mobile/credit-note-offline-prototype.js';
import {saleEventTimeSchema} from '../../../apps/mobile/sale-event-time.js';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import express from 'express';
import type {Pool} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../../../apps/api/src/commercials.js';
import {loginCommercial} from '../../../apps/api/src/commercial-session.js';
import {changeTourClosure} from '../../../apps/api/src/tour-closure-store.js';
import {identifiedCommercialRoutes,identifiedAdminRoutes} from '../../../apps/api/src/identified-tour-routes.js';
import {identifiedDeviceSchema,assertKnownDeviceEntity} from '../../../apps/mobile/identified-device.js';
import {tourCloseQueueSchema,findTourCloseAttempt,acknowledgeTourClose,observeVerifiedTourState,assertLocalTourWritable} from '../../../apps/mobile/tour-close-queue.js';
import {prepareVerifiedPrototypeClose} from '../../../apps/mobile/credit-note-verified-close-prototype.js';
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
import {remoteSaleConfirmPrototypeSchema,confirmRemoteSaleEditPrototype,readRemoteEditBalancePrototype,readRemoteEditQueuePrototype,acknowledgeRemoteEditPrototype,finalizeRemoteEditReferencePrototype,readPendingRemoteEditPrototype,recordRemoteEditFailurePrototype,readRemoteAbandonCandidatePrototype,resolveRemoteAbandonPrototype,comparePendingRemoteEditPrototype,readAbandonedRemoteEditsPrototype,recoverReceivedRemoteEditPrototype,readRecoveredRemoteEditsPrototype} from '../../../apps/mobile/credit-remote-sale-confirm-prototype.js';
import {remoteSaleDraftPrototypeSchema,stageRemoteSaleEditDraftPrototype} from '../../../apps/mobile/credit-remote-sale-draft-prototype.js';
import {captureRemoteSaleEditPrototype,previewRemoteSaleEditPrototype} from '../../../apps/mobile/credit-remote-sale-edit-prototype.js';
import {readCreditHistoryPrototype} from '../../../apps/mobile/credit-history-prototype.js';
import {reconcileLocalSalePrototype} from '../../../apps/mobile/local-sale-reconcile-prototype.js';
import {inspectLocalSaleHistoryPrototype} from '../../../apps/mobile/local-sale-history-prototype.js';
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
  const app=express();app.use(express.json());app.use('/v5',identifiedCommercialRoutes(pool,secret,{allowCreditProtocol:true}));app.use('/legacy',identifiedCommercialRoutes(pool,secret));app.use('/admin',identifiedAdminRoutes(pool,(req,res,next)=>{if(req.get('Authorization')!=='Bearer admin-test')res.sendStatus(401);else next();},'admin',{allowCreditProtocol:true}));server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server!.once('listening',resolve));
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
   ${saleEventTimeSchema}${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}${creditSourcesPrototypeSchema}${remoteSaleDraftPrototypeSchema}${remoteSaleConfirmPrototypeSchema}`);
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
  // Une preuve de source distante périmée bloque le client concerné, mais
  // ne doit pas empêcher une vente pour un autre client sans conflit.
  for(const kind of ['sale','preinvoice'] as const){
   mobile.exec('SAVEPOINT stale_note_source');
   const raw=mobile.prepare('SELECT payload FROM credit_reference_prototype_cache WHERE id=1').get()!.payload as string,ref=JSON.parse(raw);
   const proof=kind==='sale'?ref.eligibleSaleProofs.find((p:{saleId:string})=>p.saleId===saleId):ref.journalProofs.find((p:{id:string})=>p.id===invoiceId);
   proof.hash='0'.repeat(64);mobile.prepare('UPDATE credit_reference_prototype_cache SET payload=? WHERE id=1').run(JSON.stringify(ref));
   assert.equal((await readPrototypeCreditBalance(tx,identity,clientId,digest)).conflict,true);
   assert.equal((await readPrototypeCreditBalance(tx,identity,client2,digest)).conflict,false);
   assert.equal((await assertCreditWritePrototype(tx,{identity,expectedBalance:0},{kind:'sale',clientId:client2},digest)).balance,0);
   await assert.rejects(readCreditJournalExportPrototype(tx,identity,day,'Deuxième',digest),/conflit/);
   mobile.exec('ROLLBACK TO stale_note_source; RELEASE stale_note_source');
  }
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
    creditAbandon:{read:(id,op,guard)=>transaction(async()=>{guard();return readPendingCreditAbandonPrototype(tx,id,op);}),resolve:(id,verified,note,response,reference,guard)=>transaction(async()=>{guard();await resolveCreditAbandonPrototype(tx,id,verified,note,response,reference,digest);guard();})},
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
  assert.equal(await controller.abandonCredit(saleCommand.operationId),'already-received');
  assert.equal((await transaction(()=>readAllOfflineCreditPrototype(tx,identity))).filter(x=>x.pending).length,2);
  assert.equal(mobile.prepare('SELECT count(*) AS n FROM credit_abandoned_note_prototype').get()?.n,0);
  // L'expiration entre l'accusé et le commit doit annuler la transaction.
  expireDuringAck=true;await assert.rejects(controller.synchronize(),/expirée/);
  assert.equal((await transaction(()=>readAllOfflineCreditPrototype(tx,identity))).filter(x=>x.pending).length,2);
  controller=makeController();assert.deepEqual(await controller.synchronize(),{operations:0,credits:2});
  assert.deepEqual(await transaction(()=>readPrototypeCreditBalance(tx,identity,clientId,digest)),{balance:350000,conflict:false});
  await assert.rejects(transaction(()=>assertKnownDeviceEntity(tx,identity,'sale',saleId,saleProof,undefined,true)),/rapprochement/);
  await assert.rejects(transaction(()=>assertKnownDeviceEntity(tx,identity,'journal',invoiceId,undefined,journalProof,true)),/rapprochement/);
  assert.match(journalCsv(await transaction(()=>readCreditJournalExportPrototype(tx,identity,day,'Deuxième',digest))),/synchronisé/);
  for(const [kind,command] of [['sale',saleCommand],['preinvoice',preCommand]] as const){
   const received=await post(b.token,'credit-notes-abandon',{kind,command});assert.equal(received.status,200);assert.equal((await received.json()).status,'already-received');
   assert.equal((await post(a.token,'credit-notes-abandon',{kind,command})).status,409);
   assert.equal((await post(b.token,'credit-notes-abandon',{kind,command:{...command,expectedVersion:command.expectedVersion+1}})).status,409);
  }
  const abandonedPre={...preCommand,operationId:randomUUID()};
  const preAbandon=await post(b.token,'credit-notes-abandon',{kind:'preinvoice',command:abandonedPre});assert.equal(preAbandon.status,200);assert.equal((await preAbandon.json()).status,'abandoned');
  assert.equal((await post(b.token,'credit-notes/preinvoices',abandonedPre)).status,409);
  const afterPreAbandon=await get('reference');assert.equal(afterPreAbandon.version,5);

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
   isolated.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);CREATE TABLE sale_revisions(id INTEGER PRIMARY KEY AUTOINCREMENT,sale_id INTEGER NOT NULL,created_at TEXT NOT NULL,previous_payload TEXT NOT NULL,new_payload TEXT NOT NULL,refund INTEGER NOT NULL);CREATE TABLE settlements(id INTEGER PRIMARY KEY,client_id TEXT,payload TEXT);
   CREATE TABLE sales_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,sale_id TEXT,version INTEGER,payload TEXT);
   CREATE TABLE tour_pre_invoices(id TEXT PRIMARY KEY,client_id TEXT,journal_date TEXT,payload TEXT);CREATE TABLE tour_journal_receipts(id TEXT PRIMARY KEY,pre_invoice_id TEXT,client_id TEXT,journal_date TEXT,payload TEXT);
   CREATE TABLE journal_sync_state(invoice_id TEXT PRIMARY KEY,version INTEGER,payload TEXT);CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,version INTEGER,payload TEXT);
   ${saleEventTimeSchema}${identifiedDeviceSchema}${tourCloseQueueSchema}${offlineCreditPrototypeSchema}${creditReferencePrototypeSchema}${creditSourcesPrototypeSchema}${remoteSaleDraftPrototypeSchema}${remoteSaleConfirmPrototypeSchema}`);
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
   const sameReceipt=await fetch(`${origin}/v5/remote-sale-edits/${remoteEvent.operationId}/receipt`,{headers:headers(b.token)});assert.equal(sameReceipt.status,200);const sameProof=await sameReceipt.json();
   await assert.rejects(isolatedTransaction(async()=>{const result=await recoverReceivedRemoteEditPrototype(isolatedTx,identity,identity,remoteEvent.operationId,sameProof,digest);assert.equal(result.status,'current');throw Error('reprise simulée');}),/reprise simulée/);
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
   assert.equal((await post(a.token,'close',{requestId:randomUUID(),day:otherDay,expectedVersion:0})).status,409);
   // Simule une clôture historique déjà enregistrée avant cette nouvelle garde.
   await changeTourClosure(pool,first.id,otherDay,'close',{id:first.id,role:'commercial'},0);
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
   // Deuxième appareil : la version 4 est modifiée ailleurs avant notre envoi.
   const oldReference=await get('reference');
   const {id:_localId,...serverBase}=cap4.sale;
   const serverSale={...serverBase,syncVersion:4,lines:[{...serverBase.lines[0],discount:4500}],total:65450,paid:47600,remaining:17850};
   const competitor={operationId:randomUUID(),saleId:otherSaleId,version:4,recordedAt:at4,sale:serverSale,refund:0};
   assert.equal((await post(a.token,'sales',competitor)).status,201);
   const pending4=await isolatedTransaction(()=>readRemoteAbandonCandidatePrototype(isolatedTx,identity));
   assert.equal((await post(b.token,'sales',pending4.event)).status,409);
   const currentReference=await get('reference'),currentSources=await get(`credit-sources/${client2}`);
   const cachedBefore=isolated.prepare('SELECT payload FROM credit_reference_prototype_cache').get()?.payload;
   const comparison=await isolatedTransaction(()=>comparePendingRemoteEditPrototype(isolatedTx,identity,identity,draft4.operationId,currentReference,currentSources,digest));
   assert.equal(comparison.original.syncVersion,3);assert.equal(comparison.original.total,59500);
   assert.equal(comparison.proposed.syncVersion,4);assert.equal(comparison.proposed.total,71400);
   assert.equal(comparison.current?.syncVersion,4);assert.equal(comparison.current?.total,65450);assert.equal(comparison.current?.lines[0].discount,4500);
   assert.equal(comparison.cancelled,false);assert.equal(isolated.prepare('SELECT payload FROM credit_reference_prototype_cache').get()?.payload,cachedBefore);
   await assert.rejects(isolatedTransaction(()=>comparePendingRemoteEditPrototype(isolatedTx,identity,identity,draft4.operationId,oldReference,currentSources,digest)),/non confirmée|incomplètes/);
   await assert.rejects(isolatedTransaction(()=>comparePendingRemoteEditPrototype(isolatedTx,identity,identity,draft4.operationId,currentReference,sources4,digest)),/non confirmée|incomplètes/);
   await assert.rejects(isolatedTransaction(()=>comparePendingRemoteEditPrototype(isolatedTx,identity,{...identity,commercialId:first.id},draft4.operationId,currentReference,currentSources,digest)),/Session|serveur/i);
   assert.equal(isolated.prepare('SELECT payload FROM credit_reference_prototype_cache').get()?.payload,cachedBefore);
   assert.equal((await isolatedTransaction(()=>readRemoteEditQueuePrototype(isolatedTx,identity))).length,1);
   let loseAbandon=true,rollbackAbandon=true;
   const now=Date.now(),session={id:second.id,name:'Deuxième',serverOrigin:identity.serverOrigin,token:b.token,expiresAt:new Date(now+3600000).toISOString()};
   const abandonTransport=createCreditTransportPrototype(session,identity,{
    now:()=>now,request:async(url,opts)=>{const result=await fetch(url.replace(`${identity.serverOrigin}/api/mobile/identified/`,`${origin}/v5/`),opts);if(url.endsWith('/remote-sale-edits/abandon')&&loseAbandon){loseAbandon=false;throw Error('réponse abandon perdue');}return result;},
    cacheReference:async()=>{},cacheSources:async()=>{},synchronize:async()=>({operations:0,credits:0}),
    remoteCompare:(id,verified,op,reference,sources)=>isolatedTransaction(()=>comparePendingRemoteEditPrototype(isolatedTx,id,verified,op,reference,sources,digest)),
    remoteAbandon:{read:()=>isolatedTransaction(()=>readRemoteAbandonCandidatePrototype(isolatedTx,identity)),resolve:(id,verified,entry,response,reference)=>isolatedTransaction(async()=>{await resolveRemoteAbandonPrototype(isolatedTx,id,verified,entry,response,reference,digest);if(rollbackAbandon){rollbackAbandon=false;throw Error('session interrompue');}})}
   });
   const fromTransport=await abandonTransport.compareRemoteEdit(draft4.operationId,client2);assert.equal(fromTransport.current?.total,65450);
   assert.equal(isolated.prepare('SELECT payload FROM credit_reference_prototype_cache').get()?.payload,cachedBefore);
   await assert.rejects(abandonTransport.abandonRemoteEdit(),/réponse abandon perdue/);
   assert.equal((await isolatedTransaction(()=>readRemoteEditQueuePrototype(isolatedTx,identity))).length,1);
   const savedCandidate=await isolatedTransaction(()=>readRemoteAbandonCandidatePrototype(isolatedTx,identity));
   assert.equal((await post(b.token,'sales',savedCandidate.event)).status,409);
   await assert.rejects(abandonTransport.abandonRemoteEdit(),/session interrompue/);
   assert.equal((await isolatedTransaction(()=>readRemoteEditQueuePrototype(isolatedTx,identity))).length,1);
   assert.equal(isolated.prepare('SELECT count(*) AS n FROM credit_remote_sale_abandoned_prototype').get()?.n,0);
   assert.equal(await abandonTransport.abandonRemoteEdit(),'abandoned');
   assert.equal(await isolatedTransaction(()=>readPendingRemoteEditPrototype(isolatedTx,identity)),null);
   assert.deepEqual(await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,client2,digest)),{balance:17850,conflict:false});
   assert.equal(isolated.prepare('SELECT count(*) AS n FROM credit_remote_sale_abandoned_prototype').get()?.n,1);
   await assert.rejects(isolatedTransaction(()=>confirmRemoteSaleEditPrototype(isolatedTx,draft4,digest)),/abandonnée/);
   const archive=await isolatedTransaction(()=>readAbandonedRemoteEditsPrototype(isolatedTx,identity,client2,digest));assert.equal(archive.length,1);
   assert.equal(archive[0].operationId,draft4.operationId);assert.equal(archive[0].original.total,59500);assert.equal(archive[0].proposed.total,71400);
   assert.equal((await isolatedTransaction(()=>readAbandonedRemoteEditsPrototype(isolatedTx,identity,clientId,digest))).length,0);
   isolated.exec('SAVEPOINT bad_receipt');isolated.prepare('UPDATE credit_remote_sale_abandoned_prototype SET server_receipt=? WHERE operation_id=?').run('{}',draft4.operationId);
   await assert.rejects(readAbandonedRemoteEditsPrototype(isolatedTx,identity,client2,digest),/incohérente/);isolated.exec('ROLLBACK TO bad_receipt; RELEASE bad_receipt');

   assert.equal(isolated.prepare('SELECT count(*) AS n FROM credit_remote_sale_confirm_prototype WHERE acknowledged=2').get()?.n,3);
   assert.equal(isolated.prepare('SELECT count(*) AS n FROM sales').get()?.n,1);assert.equal(isolated.prepare('SELECT count(*) AS n FROM sales_outbox').get()?.n,0);
  assert.equal((await post(b.token,'sales',remoteEvent)).status,200);
  assert.equal((await post(b.token,'sales',{...remoteEvent,operationId:randomUUID()})).status,409);
  const otherVersions=await db.query<{version:number;commercial_id:string}>('SELECT version,commercial_id FROM identified_sale_events WHERE sale_id=$1 ORDER BY version',[otherSaleId]);
  assert.deepEqual(otherVersions.rows.map(x=>[x.version,x.commercial_id]),[[1,first.id],[2,second.id],[3,second.id],[4,first.id]]);
  const dayA=await fetch(`${origin}/v5/day/${otherDay}/details`,{headers:headers(a.token)}),dayB=await fetch(`${origin}/v5/day/${otherDay}/details`,{headers:headers(b.token)});
  assert.equal(dayA.status,409);assert.equal(dayB.status,409);
  assert.match((await dayA.json() as {error:string}).error,/remboursement/i);
  assert.match((await dayB.json() as {error:string}).error,/remboursement/i);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1',[otherSaleId])).rows[0].n,4);
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
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM identified_sale_events WHERE sale_id=$1',[otherSaleId])).rows[0].n,4);

  // Un avoir créé ailleurs pendant une révision doit être explicitement
  // affiché comme annulation, jamais comme une facture encore modifiable.
  const sources5=await get(`credit-sources/${client2}`);await isolatedTransaction(()=>saveCreditSourcesPrototype(isolatedTx,identity,identity,client2,sources5,digest));
  const item5=sources5.items.find((x:{kind:string;invoiceId:string})=>x.kind==='sale'&&x.invoiceId===otherSaleId);
  const key5={clientId:client2,invoiceId:otherSaleId,version:item5.version,hash:item5.hash},ctx5={identity,expectedBalance:17850},at5='2026-11-07T13:00:00.000Z';
  const cap5=await isolatedTransaction(()=>captureRemoteSaleEditPrototype(isolatedTx,ctx5,key5,at5,digest)),lines5=[{...cap5.sale.lines[0],discount:3500}];
  const preview5=await isolatedTransaction(()=>previewRemoteSaleEditPrototype(isolatedTx,ctx5,key5,at5,lines5,undefined,digest));
  const draft5={operationId:randomUUID(),context:ctx5,key:key5,recordedAt:at5,lines:lines5,preview:preview5};
  await isolatedTransaction(()=>stageRemoteSaleEditDraftPrototype(isolatedTx,draft5,digest));await isolatedTransaction(()=>confirmRemoteSaleEditPrototype(isolatedTx,draft5,digest));
  const credit={operationId:randomUUID(),invoiceId:otherSaleId,expectedVersion:4,recordedAt:at5,choice:'refund'};
  assert.equal((await post(a.token,'credit-notes/sales',credit)).status,201);
  const cancelledRef=await get('reference'),cancelledSources=await get(`credit-sources/${client2}`);
  const cancelledCompare=await isolatedTransaction(()=>comparePendingRemoteEditPrototype(isolatedTx,identity,identity,draft5.operationId,cancelledRef,cancelledSources,digest));
  assert.equal(cancelledCompare.cancelled,true);assert.equal(cancelledCompare.current,null);assert.equal(cancelledCompare.currentVersion,5);
  assert.equal((await isolatedTransaction(()=>readRemoteEditQueuePrototype(isolatedTx,identity))).length,1);
  assert.equal((await post(b.token,'sales',(await isolatedTransaction(()=>readRemoteAbandonCandidatePrototype(isolatedTx,identity))).event)).status,409);
  assert.equal(await abandonTransport.abandonRemoteEdit(),'abandoned');
  assert.equal(await isolatedTransaction(()=>readPendingRemoteEditPrototype(isolatedTx,identity)),null);
  assert.deepEqual(await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,client2,digest)),{balance:0,conflict:false});
  const afterCreditArchive=await isolatedTransaction(()=>readAbandonedRemoteEditsPrototype(isolatedTx,identity,client2,digest));assert.equal(afterCreditArchive.length,2);assert.equal(afterCreditArchive[0].operationId,draft5.operationId);

  // Une réponse perdue ne doit pas bloquer indéfiniment si une autre
  // modification ou un avoir survient après l'enregistrement serveur.
  const receiptSaleId=randomUUID(),receiptSale={...otherSale,syncSaleId:receiptSaleId};
  assert.equal((await post(a.token,'sales',{operationId:randomUUID(),saleId:receiptSaleId,version:1,recordedAt:otherAt,sale:receiptSale,refund:0})).status,201);
  const beforeReceiptEdit=await get('reference');await isolatedTransaction(()=>saveVerifiedCreditReference(isolatedTx,identity,identity,beforeReceiptEdit,digest));
  const receiptSources=await get(`credit-sources/${client2}`);await isolatedTransaction(()=>saveCreditSourcesPrototype(isolatedTx,identity,identity,client2,receiptSources,digest));
  const receiptSource=receiptSources.items.find((x:{kind:string;invoiceId:string})=>x.kind==='sale'&&x.invoiceId===receiptSaleId);
  const receiptKey={clientId:client2,invoiceId:receiptSaleId,version:receiptSource.version,hash:receiptSource.hash},receiptContext={identity,expectedBalance:69000},receiptAt='2026-11-07T10:00:00.000Z';
  const receiptCapture=await isolatedTransaction(()=>captureRemoteSaleEditPrototype(isolatedTx,receiptContext,receiptKey,receiptAt,digest));const receiptLines=[{...receiptCapture.sale.lines[0],discount:6000}];
  const receiptPreview=await isolatedTransaction(()=>previewRemoteSaleEditPrototype(isolatedTx,receiptContext,receiptKey,receiptAt,receiptLines,'refund',digest));
  const receiptDraft={operationId:randomUUID(),context:receiptContext,key:receiptKey,recordedAt:receiptAt,lines:receiptLines,choice:'refund' as const,preview:receiptPreview};
  await isolatedTransaction(()=>stageRemoteSaleEditDraftPrototype(isolatedTx,receiptDraft,digest));await isolatedTransaction(()=>confirmRemoteSaleEditPrototype(isolatedTx,receiptDraft,digest));
  const pendingReceipt=await isolatedTransaction(()=>readRemoteAbandonCandidatePrototype(isolatedTx,identity));assert.equal((await post(b.token,'sales',pendingReceipt.event)).status,201);
  const laterSale={...remoteModified,syncSaleId:receiptSaleId,syncVersion:3,lines:[{...remoteModified.lines[0],discount:5000}],total:59500,paid:47600,remaining:11900};
  assert.equal((await post(a.token,'sales',{operationId:randomUUID(),saleId:receiptSaleId,version:3,recordedAt:'2026-11-07T11:00:00.000Z',sale:laterSale,refund:0})).status,201);
  const receiptUrl=`${origin}/v5/remote-sale-edits/${receiptDraft.operationId}/receipt`;
  assert.equal((await fetch(`${origin}/legacy/remote-sale-edits/${receiptDraft.operationId}/receipt`,{headers:headers(b.token)})).status,404);
  assert.equal((await fetch(receiptUrl,{headers:headers(a.token)})).status,404);
  assert.equal((await fetch(receiptUrl,{headers:{...headers(b.token),'X-SLS-Reference-Version':'4'}})).status,409);
  assert.equal((await fetch(receiptUrl,{headers:headers('invalid')})).status,401);
  assert.equal((await fetch(`${origin}/v5/remote-sale-edits/${randomUUID()}/receipt`,{headers:headers(b.token)})).status,404);
  const oldHash=await db.query<{payload_hash:string}>('SELECT payload_hash FROM identified_sale_events WHERE operation_id=$1',[receiptDraft.operationId]);
  await db.query('UPDATE identified_sale_events SET payload_hash=$2 WHERE operation_id=$1',[receiptDraft.operationId,'x'.repeat(64)]);
  assert.equal((await fetch(receiptUrl,{headers:headers(b.token)})).status,409);
  await db.query('UPDATE identified_sale_events SET payload_hash=$2 WHERE operation_id=$1',[receiptDraft.operationId,oldHash.rows[0].payload_hash]);
  const response=await fetch(receiptUrl,{headers:headers(b.token)});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const proof=await response.json();
  assert.equal(proof.event.operationId,receiptDraft.operationId);assert.equal(proof.commercialId,second.id);
  const beforeRecovery=isolated.prepare('SELECT payload FROM credit_reference_prototype_cache').get()?.payload;
  await assert.rejects(isolatedTransaction(()=>recoverReceivedRemoteEditPrototype(isolatedTx,identity,identity,receiptDraft.operationId,{...proof,event:{...proof.event,refund:1}},digest)),/Preuve/);
  await assert.rejects(isolatedTransaction(()=>recoverReceivedRemoteEditPrototype(isolatedTx,identity,identity,receiptDraft.operationId,{...proof,reference:beforeReceiptEdit},digest)),/antérieure|incohérent/);
  await assert.rejects(isolatedTransaction(()=>recoverReceivedRemoteEditPrototype(isolatedTx,identity,{...identity,commercialId:first.id},receiptDraft.operationId,proof,digest)),/Session|serveur/i);
  await assert.rejects(isolatedTransaction(async()=>{await recoverReceivedRemoteEditPrototype(isolatedTx,identity,identity,receiptDraft.operationId,proof,digest);throw Error('expiration pendant récupération');}),/expiration/);
  assert.equal(isolated.prepare('SELECT payload FROM credit_reference_prototype_cache').get()?.payload,beforeRecovery);
  assert.equal(isolated.prepare('SELECT count(*) AS n FROM credit_remote_sale_receipt_prototype').get()?.n,0);
  assert.equal((await isolatedTransaction(()=>readRemoteEditQueuePrototype(isolatedTx,identity))).length,1);
  const recoverTransport=createCreditTransportPrototype(session,identity,{now:()=>now,request:(url,opts)=>fetch(url.replace(`${identity.serverOrigin}/api/mobile/identified/`,`${origin}/v5/`),opts),cacheReference:async()=>{},cacheSources:async()=>{},synchronize:async()=>({operations:0,credits:0}),remoteRecover:(id,verified,op,body)=>isolatedTransaction(()=>recoverReceivedRemoteEditPrototype(isolatedTx,id,verified,op,body,digest))});
  assert.deepEqual(await recoverTransport.recoverRemoteEdit(receiptDraft.operationId),{operationId:receiptDraft.operationId,status:'superseded',currentVersion:3});
  assert.equal(await isolatedTransaction(()=>readPendingRemoteEditPrototype(isolatedTx,identity)),null);
  assert.deepEqual(await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,client2,digest)),{balance:11900,conflict:false});
  assert.equal(isolated.prepare('SELECT count(*) AS n FROM credit_remote_sale_receipt_prototype').get()?.n,1);
  // Une deuxième révision a été acquittée puis annulée par un autre acteur.
  const nextSources=await get(`credit-sources/${client2}`);await isolatedTransaction(()=>saveCreditSourcesPrototype(isolatedTx,identity,identity,client2,nextSources,digest));
  const nextSource=nextSources.items.find((x:{kind:string;invoiceId:string})=>x.kind==='sale'&&x.invoiceId===receiptSaleId);
  const nextKey={clientId:client2,invoiceId:receiptSaleId,version:nextSource.version,hash:nextSource.hash},nextContext={identity,expectedBalance:11900},nextReceiptAt='2026-11-07T12:00:00.000Z';
  const nextCapture=await isolatedTransaction(()=>captureRemoteSaleEditPrototype(isolatedTx,nextContext,nextKey,nextReceiptAt,digest)),nextReceiptLines=[{...nextCapture.sale.lines[0],discount:4000}];
  const nextReceiptPreview=await isolatedTransaction(()=>previewRemoteSaleEditPrototype(isolatedTx,nextContext,nextKey,nextReceiptAt,nextReceiptLines,undefined,digest));
  const nextReceiptDraft={operationId:randomUUID(),context:nextContext,key:nextKey,recordedAt:nextReceiptAt,lines:nextReceiptLines,preview:nextReceiptPreview};
  await isolatedTransaction(()=>stageRemoteSaleEditDraftPrototype(isolatedTx,nextReceiptDraft,digest));await isolatedTransaction(()=>confirmRemoteSaleEditPrototype(isolatedTx,nextReceiptDraft,digest));
  const nextPending=await isolatedTransaction(()=>readRemoteAbandonCandidatePrototype(isolatedTx,identity));assert.equal((await post(b.token,'sales',nextPending.event)).status,201);
  await isolatedTransaction(()=>acknowledgeRemoteEditPrototype(isolatedTx,identity,nextPending.entry));
  assert.equal((await post(a.token,'credit-notes/sales',{operationId:randomUUID(),invoiceId:receiptSaleId,expectedVersion:4,recordedAt:'2026-11-07T13:00:00.000Z',choice:'refund'})).status,201);
  assert.deepEqual(await recoverTransport.recoverRemoteEdit(nextReceiptDraft.operationId),{operationId:nextReceiptDraft.operationId,status:'cancelled',currentVersion:5});
  assert.equal(await isolatedTransaction(()=>readPendingRemoteEditPrototype(isolatedTx,identity)),null);
  assert.deepEqual(await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,client2,digest)),{balance:0,conflict:false});
  assert.equal(isolated.prepare('SELECT count(*) AS n FROM credit_remote_sale_receipt_prototype').get()?.n,2);
  const recoveredArchive=await isolatedTransaction(()=>readRecoveredRemoteEditsPrototype(isolatedTx,identity,client2,digest));assert.equal(recoveredArchive.length,2);
  assert.equal(recoveredArchive[0].operationId,nextReceiptDraft.operationId);assert.equal(recoveredArchive[0].referenceVersion,5);
  assert.equal(recoveredArchive[1].operationId,receiptDraft.operationId);assert.equal(recoveredArchive[1].refund,2400);assert.equal(recoveredArchive[1].referenceVersion,3);
  isolated.exec('SAVEPOINT bad_recovery');isolated.prepare('UPDATE credit_remote_sale_receipt_prototype SET receipt=? WHERE operation_id=?').run('{}',receiptDraft.operationId);
  await assert.rejects(readRecoveredRemoteEditsPrototype(isolatedTx,identity,client2,digest),/incohérente/);isolated.exec('ROLLBACK TO bad_recovery; RELEASE bad_recovery');

  // La vente locale de B a été révisée par A : diagnostiquer sans écraser
  // la facture de B, ses versions locales ni ses éventuelles files.
  const localRow=isolated.prepare('SELECT id,payload FROM sales WHERE client_id=?').get(clientId) as {id:number;payload:string};assert.ok(localRow);
  const localHistoryUrl=`${origin}/v5/local-sales/${offlineSaleId}/history`;
  assert.equal((await fetch(localHistoryUrl,{headers:headers(a.token)})).status,404);
  assert.equal((await fetch(localHistoryUrl,{headers:headers('invalid')})).status,401);
  assert.equal((await fetch(localHistoryUrl,{headers:{...headers(b.token),'X-SLS-Reference-Version':'4'}})).status,409);
  assert.equal((await fetch(`${origin}/legacy/local-sales/${offlineSaleId}/history`,{headers:headers(b.token)})).status,404);
  const readLocalHistory=async()=>{const response=await fetch(localHistoryUrl,{headers:headers(b.token)});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');return response.json();};
  const sameHistory=await readLocalHistory();assert.equal(JSON.stringify(sameHistory).includes('purchase'),false);
  const originalCache=isolated.prepare('SELECT payload FROM credit_reference_prototype_cache').get()?.payload;
  const sameResult=await isolatedTransaction(()=>inspectLocalSaleHistoryPrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,sameHistory,digest));assert.equal(sameResult.status,'same');
  isolated.exec('SAVEPOINT close_consistent');await saveVerifiedCreditReference(isolatedTx,identity,identity,sameHistory.reference,digest);
  assert.equal((await prepareVerifiedPrototypeClose(isolatedTx,identity,'2026-11-06',0,randomUUID,digest)).status,'closing');
  isolated.exec('ROLLBACK TO close_consistent; RELEASE close_consistent');

  const modifiedOffline={...offlineSale,syncVersion:2,lines:offlineSale.lines.map(line=>({...line,quantity:line.quantity*2})),total:offlineSale.total*2,remaining:offlineSale.remaining*2};
  assert.equal((await post(a.token,'sales',{operationId:randomUUID(),saleId:offlineSaleId,version:2,recordedAt:'2026-11-07T13:00:00.000Z',sale:modifiedOffline,refund:0})).status,201);
  const latestHistory=await readLocalHistory();const inspected=await isolatedTransaction(()=>inspectLocalSaleHistoryPrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,latestHistory,digest));
  assert.equal(inspected.status,'updated');assert.equal(inspected.local.syncVersion,1);assert.equal(inspected.events.length,2);assert.equal(inspected.events[1].event.sale.total,offlineSale.total*2);assert.equal(inspected.events[1].commercialId,first.id);
  assert.equal(isolated.prepare('SELECT payload FROM sales WHERE id=?').get(localRow.id)?.payload,localRow.payload);assert.equal(isolated.prepare('SELECT payload FROM credit_reference_prototype_cache').get()?.payload,originalCache);
  assert.equal(isolated.prepare('SELECT count(*) AS n FROM sales_outbox').get()?.n,0);
  // Une file vide ne suffit pas à autoriser la clôture si le solde local et
  // la version serveur divergent ; aucune tentative n'est alors créée.
  isolated.exec('SAVEPOINT close_conflict');await saveVerifiedCreditReference(isolatedTx,identity,identity,latestHistory.reference,digest);
  await assert.rejects(prepareVerifiedPrototypeClose(isolatedTx,identity,'2026-11-06',0,randomUUID,digest),/conflit|rapprochement/i);
  assert.equal(isolated.prepare('SELECT count(*) AS n FROM tour_close_attempts').get()?.n,0);isolated.exec('ROLLBACK TO close_conflict; RELEASE close_conflict');
  await assert.rejects(isolatedTransaction(()=>inspectLocalSaleHistoryPrototype(isolatedTx,identity,{...identity,commercialId:first.id},localRow.id,offlineSaleId,latestHistory,digest)),/Identité/);
  await assert.rejects(isolatedTransaction(()=>inspectLocalSaleHistoryPrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,{...latestHistory,events:latestHistory.events.slice(1)},digest)),/invalide|incohérente/);
  await assert.rejects(isolatedTransaction(()=>inspectLocalSaleHistoryPrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,{...latestHistory,reference:sameHistory.reference},digest)),/incohérente/);
  isolated.exec('SAVEPOINT pending_local');isolated.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(randomUUID(),offlineSaleId,3,'{}');
  assert.equal((await inspectLocalSaleHistoryPrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,latestHistory,digest)).status,'pending');isolated.exec('ROLLBACK TO pending_local; RELEASE pending_local');
  isolated.exec('SAVEPOINT divergent_local');const divergent={...offlineSale,clientName:'Nom différent'};isolated.prepare('UPDATE sales SET payload=? WHERE id=?').run(JSON.stringify(divergent),localRow.id);
  assert.equal((await inspectLocalSaleHistoryPrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,latestHistory,digest)).status,'diverged');
  await assert.rejects(reconcileLocalSalePrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,latestHistory,inspected.fingerprint,digest),/changé depuis/);isolated.exec('ROLLBACK TO divergent_local; RELEASE divergent_local');
  const inspectTransport=createCreditTransportPrototype(session,identity,{now:()=>now,request:(url,opts)=>fetch(url.replace(`${identity.serverOrigin}/api/mobile/identified/`,`${origin}/v5/`),opts),cacheReference:async()=>{},cacheSources:async()=>{},synchronize:async()=>({operations:0,credits:0}),localSaleInspect:(id,verified,localId,saleId,body)=>isolatedTransaction(()=>inspectLocalSaleHistoryPrototype(isolatedTx,id,verified,localId,saleId,body,digest)),localSaleReconcile:(id,verified,localId,saleId,body,fingerprint)=>isolatedTransaction(()=>reconcileLocalSalePrototype(isolatedTx,id,verified,localId,saleId,body,fingerprint,digest))});
  assert.equal((await inspectTransport.inspectLocalSale(localRow.id,offlineSaleId)).status,'updated');
  // La mise à jour n'applique que la chaîne revue, sans file ni mouvement
  // local équivoque et sous transaction unique.
  await assert.rejects(isolatedTransaction(()=>reconcileLocalSalePrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,latestHistory,sameResult.fingerprint,digest)),/changé depuis/);
  await assert.rejects(isolatedTransaction(async()=>{await reconcileLocalSalePrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,latestHistory,inspected.fingerprint,digest);throw Error('session expirée pendant rapprochement');}),/session expirée/);
  assert.equal(isolated.prepare('SELECT payload FROM sales WHERE id=?').get(localRow.id)?.payload,localRow.payload);assert.equal(isolated.prepare('SELECT count(*) AS n FROM sale_revisions').get()?.n,0);
  assert.equal(isolated.prepare('SELECT payload FROM credit_reference_prototype_cache').get()?.payload,originalCache);
  isolated.exec('SAVEPOINT pending_reconcile');isolated.prepare('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)').run(randomUUID(),offlineSaleId,3,'{}');
  await assert.rejects(reconcileLocalSalePrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,latestHistory,inspected.fingerprint,digest),/Opération ou avoir/);
  isolated.exec('ROLLBACK TO pending_reconcile; RELEASE pending_reconcile');
  isolated.exec('SAVEPOINT missing_origin');isolated.prepare('DELETE FROM identified_local_operations WHERE operation_id=?').run(offlineOperation);
  await assert.rejects(reconcileLocalSalePrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,latestHistory,inspected.fingerprint,digest),/Origine locale/);isolated.exec('ROLLBACK TO missing_origin; RELEASE missing_origin');
  isolated.exec('SAVEPOINT used_uuid');isolated.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(inspected.events[1].event.operationId,identity.commercialId,'sale',randomUUID(),otherAt);
  await assert.rejects(reconcileLocalSalePrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,latestHistory,inspected.fingerprint,digest),/Identifiant de version/);isolated.exec('ROLLBACK TO used_uuid; RELEASE used_uuid');
  isolated.exec('SAVEPOINT used_draft');isolated.prepare('INSERT INTO credit_remote_sale_draft_prototype VALUES(?,?,?,?,?,?)').run(inspected.events[1].event.operationId,randomUUID(),identity.commercialId,identity.serverOrigin,'{}','{}');
  await assert.rejects(reconcileLocalSalePrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,latestHistory,inspected.fingerprint,digest),/Identifiant de version/);isolated.exec('ROLLBACK TO used_draft; RELEASE used_draft');
  isolated.exec('SAVEPOINT used_timestamp');isolated.prepare('INSERT INTO sale_event_times VALUES(?,?)').run(inspected.events[1].event.operationId,otherAt);
  await assert.rejects(reconcileLocalSalePrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,latestHistory,inspected.fingerprint,digest),/Identifiant de version/);isolated.exec('ROLLBACK TO used_timestamp; RELEASE used_timestamp');
  isolated.exec('SAVEPOINT invalid_history');isolated.prepare('INSERT INTO sale_revisions(sale_id,created_at,previous_payload,new_payload,refund) VALUES(?,?,?,?,?)').run(localRow.id,otherAt,'{}','{}',0);
  await assert.rejects(reconcileLocalSalePrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,latestHistory,inspected.fingerprint,digest),/Historique local incomplet/);isolated.exec('ROLLBACK TO invalid_history; RELEASE invalid_history');
  const applied=await inspectTransport.reconcileLocalSale(localRow.id,offlineSaleId,inspected.fingerprint);
  assert.equal(applied.versionsAdded,1);assert.equal(applied.cancelled,false);assert.equal((await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,clientId,digest))).conflict,false);
  assert.equal(JSON.parse(String(isolated.prepare('SELECT payload FROM sales WHERE id=?').get(localRow.id)?.payload)).syncVersion,2);
  assert.equal(isolated.prepare('SELECT count(*) AS n FROM sale_revisions WHERE sale_id=?').get(localRow.id)?.n,1);
  assert.equal(isolated.prepare('SELECT count(*) AS n FROM credit_local_sale_reconcile_prototype WHERE sale_id=?').get(offlineSaleId)?.n,1);
  assert.equal(isolated.prepare('SELECT count(*) AS n FROM sales_outbox').get()?.n,0);
  const alreadyCompared=await inspectTransport.inspectLocalSale(localRow.id,offlineSaleId);assert.equal(alreadyCompared.status,'same');
  const replay=await isolatedTransaction(()=>reconcileLocalSalePrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,latestHistory,alreadyCompared.fingerprint,digest));assert.equal(replay.versionsAdded,0);
  assert.equal(isolated.prepare('SELECT count(*) AS n FROM sale_revisions WHERE sale_id=?').get(localRow.id)?.n,1);
  // Une nouvelle version distante après l’aperçu rend l'ancienne empreinte
  // inutilisable ; la deuxième importation conserve les deux révisions.
  assert.equal((await post(a.token,'sales',{operationId:randomUUID(),saleId:offlineSaleId,version:3,recordedAt:'2026-11-07T13:30:00.000Z',sale:{...modifiedOffline,syncVersion:3},refund:0})).status,201);
  const thirdHistory=await readLocalHistory();await assert.rejects(isolatedTransaction(()=>reconcileLocalSalePrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,thirdHistory,alreadyCompared.fingerprint,digest)),/changé depuis/);
  await assert.rejects(inspectTransport.reconcileLocalSale(localRow.id,offlineSaleId,alreadyCompared.fingerprint),/changé depuis/);
  const thirdPreview=await isolatedTransaction(()=>inspectLocalSaleHistoryPrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,thirdHistory,digest));
  assert.equal((await isolatedTransaction(()=>reconcileLocalSalePrototype(isolatedTx,identity,identity,localRow.id,offlineSaleId,thirdHistory,thirdPreview.fingerprint,digest))).versionsAdded,1);
  const historyAfter=await isolatedTransaction(()=>readCreditHistoryPrototype(isolatedTx,identity,clientId,digest));assert.equal(historyAfter.sales[0].revisions.length,2);assert.ok(historyAfter.sales[0].revisions.every(r=>r.origin==='remote'&&r.commercialId===first.id));
  const updatedJournal=await isolatedTransaction(()=>readCreditJournalExportPrototype(isolatedTx,identity,otherDay,'Deuxième',digest));
  assert.ok(updatedJournal.remoteSaleUpdates?.some(x=>x.saleId===offlineSaleId));assert.match(journalCsv(updatedJournal),/modification du .* enregistrée ailleurs/);
  assert.ok(describeCreditJournalPrototype(updatedJournal).rows.flatMap(r=>r.sales).some(s=>s.syncSaleId===offlineSaleId&&s.remoteUpdateDay));

  isolated.exec('SAVEPOINT tampered_audit');isolated.prepare('UPDATE credit_local_sale_reconcile_prototype SET event=? WHERE sale_id=?').run('{}',offlineSaleId);
  await assert.rejects(readCreditHistoryPrototype(isolatedTx,identity,clientId,digest),/Historique distant incohérent/);
  await assert.rejects(readCreditJournalExportPrototype(isolatedTx,identity,otherDay,'Deuxième',digest),/Historique distant incohérent/);isolated.exec('ROLLBACK TO tampered_audit; RELEASE tampered_audit');
  isolated.exec('SAVEPOINT bad_actor');isolated.prepare('UPDATE credit_local_sale_reconcile_prototype SET commercial_id=? WHERE sale_id=?').run('non-uuid',offlineSaleId);
  await assert.rejects(readCreditHistoryPrototype(isolatedTx,identity,clientId,digest),/Historique distant incohérent/);
  await assert.rejects(readCreditJournalExportPrototype(isolatedTx,identity,otherDay,'Deuxième',digest),/Historique distant incohérent/);isolated.exec('ROLLBACK TO bad_actor; RELEASE bad_actor');
  isolated.exec('SAVEPOINT bad_previous');isolated.prepare("UPDATE sale_revisions SET previous_payload=json_set(previous_payload,'$.paid',999) WHERE sale_id=?").run(localRow.id);
  await assert.rejects(readCreditHistoryPrototype(isolatedTx,identity,clientId,digest),/Historique distant incohérent/);
  await assert.rejects(readCreditJournalExportPrototype(isolatedTx,identity,otherDay,'Deuxième',digest),/Historique distant incohérent/);isolated.exec('ROLLBACK TO bad_previous; RELEASE bad_previous');
  // Une édition faite ensuite sur ce téléphone garde son origine locale et
  // peut être suivie d'une nouvelle version importée depuis un autre appareil.
  const localVersion4={...modifiedOffline,syncVersion:4},localEditId=randomUUID(),localEditAt='2026-11-07T13:35:00.000Z';
  isolated.prepare('INSERT INTO sale_revisions(sale_id,created_at,previous_payload,new_payload,refund) VALUES(?,?,?,?,?)').run(localRow.id,localEditAt,JSON.stringify({...modifiedOffline,syncVersion:3,id:localRow.id}),JSON.stringify({...localVersion4,id:localRow.id}),0);
  isolated.prepare('UPDATE sales SET payload=? WHERE id=?').run(JSON.stringify(localVersion4),localRow.id);
  isolated.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(localEditId,identity.commercialId,'sale',offlineSaleId,localEditAt);
  assert.equal((await post(b.token,'sales',{operationId:localEditId,saleId:offlineSaleId,version:4,recordedAt:localEditAt,sale:localVersion4,refund:0})).status,201);
  const afterLocalVersion=await get('reference');await isolatedTransaction(()=>saveVerifiedCreditReference(isolatedTx,identity,identity,afterLocalVersion,digest));
  assert.equal((await post(a.token,'sales',{operationId:randomUUID(),saleId:offlineSaleId,version:5,recordedAt:'2026-11-07T13:40:00.000Z',sale:{...localVersion4,syncVersion:5},refund:0})).status,201);
  const afterLocalPreview=await inspectTransport.inspectLocalSale(localRow.id,offlineSaleId);assert.equal(afterLocalPreview.status,'updated');
  assert.equal((await inspectTransport.reconcileLocalSale(localRow.id,offlineSaleId,afterLocalPreview.fingerprint)).versionsAdded,1);
  const mixedOrigins=await isolatedTransaction(()=>readCreditHistoryPrototype(isolatedTx,identity,clientId,digest));assert.deepEqual(mixedOrigins.sales[0].revisions.map(r=>r.origin),['remote','local','remote','remote']);

  assert.equal((await post(a.token,'credit-notes/sales',{operationId:randomUUID(),invoiceId:offlineSaleId,expectedVersion:5,recordedAt:'2026-11-07T14:00:00.000Z',choice:null})).status,201);
  const cancelledLocal=await inspectTransport.inspectLocalSale(localRow.id,offlineSaleId);assert.equal(cancelledLocal.status,'cancelled');assert.equal(cancelledLocal.serverVersion,6);
  const cancelledApplied=await inspectTransport.reconcileLocalSale(localRow.id,offlineSaleId,cancelledLocal.fingerprint);assert.equal(cancelledApplied.cancelled,true);assert.equal(cancelledApplied.versionsAdded,0);
  assert.equal((await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,clientId,digest))).conflict,false);
  const cancelledJournal=await isolatedTransaction(()=>readCreditJournalExportPrototype(isolatedTx,identity,otherDay,'Deuxième',digest));assert.ok(cancelledJournal.remoteCancellations?.some(x=>x.invoiceId===offlineSaleId));
  assert.equal(JSON.parse(String(isolated.prepare('SELECT payload FROM sales WHERE id=?').get(localRow.id)?.payload)).syncVersion,5);
  // Une version distante avec remboursement peut être importée sous preuve,
  // sans déclarer que le versement a eu lieu sur ce téléphone. Le journal de
  // la vente reste bloqué tant que sa caisse n'est pas rapprochée.
  const refundSaleId=randomUUID(),refundOp=randomUUID(),refundSale={...otherSale,syncSaleId:refundSaleId};
  assert.equal((await post(b.token,'sales',{operationId:refundOp,saleId:refundSaleId,version:1,recordedAt:otherAt,sale:refundSale,refund:0})).status,201);
  isolated.prepare('INSERT INTO sales(client_id,payload) VALUES(?,?)').run(client2,JSON.stringify(refundSale));const refundId=Number(isolated.prepare('SELECT last_insert_rowid() AS id').get()?.id);
  isolated.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(refundOp,identity.commercialId,'sale',refundSaleId,otherAt);
  assert.equal((await post(a.token,'sales',{operationId:randomUUID(),saleId:refundSaleId,version:2,recordedAt:'2026-11-07T10:00:00.000Z',sale:{...remoteModified,syncSaleId:refundSaleId},refund:2400})).status,201);
  const refundResponse=await fetch(`${origin}/v5/local-sales/${refundSaleId}/history`,{headers:headers(b.token)});assert.equal(refundResponse.status,200);const refundHistory=await refundResponse.json();
  const refundPreview=await isolatedTransaction(()=>inspectLocalSaleHistoryPrototype(isolatedTx,identity,identity,refundId,refundSaleId,refundHistory,digest));assert.equal(refundPreview.status,'updated');
  const appliedRefund=await isolatedTransaction(()=>reconcileLocalSalePrototype(isolatedTx,identity,identity,refundId,refundSaleId,refundHistory,refundPreview.fingerprint,digest));assert.equal(appliedRefund.versionsAdded,1);
  assert.equal(JSON.parse(String(isolated.prepare('SELECT payload FROM sales WHERE id=?').get(refundId)?.payload)).syncVersion,2);assert.equal(isolated.prepare('SELECT count(*) AS n FROM sale_revisions WHERE sale_id=?').get(refundId)?.n,1);
  const refundHistoryLocal=await isolatedTransaction(()=>readCreditHistoryPrototype(isolatedTx,identity,client2,digest));assert.ok(refundHistoryLocal.sales.some(s=>s.sale.syncSaleId===refundSaleId&&s.revisions.some(r=>r.origin==='remote'&&r.refund===2400&&r.commercialId===first.id)));
  await assert.rejects(isolatedTransaction(()=>readCreditJournalExportPrototype(isolatedTx,identity,otherDay,'Deuxième',digest)),/Remboursement enregistré ailleurs/);
  await assert.rejects(isolatedTransaction(()=>prepareVerifiedPrototypeClose(isolatedTx,identity,otherDay,0,randomUUID,digest)),/Remboursement enregistré ailleurs|conflit|rapprochement/i);
  isolated.exec('SAVEPOINT bad_refund_audit');isolated.prepare('UPDATE sale_revisions SET refund=refund+1 WHERE sale_id=?').run(refundId);
  await assert.rejects(readCreditHistoryPrototype(isolatedTx,identity,client2,digest),/Historique distant incohérent/);isolated.exec('ROLLBACK TO bad_refund_audit; RELEASE bad_refund_audit');

  // Deux factures divergentes du même client peuvent être rapprochées une par
  // une ; entre les deux, son solde et la clôture restent bloqués.
  const twoSales:{id:string;localId:number;updated:typeof offlineSale}[]=[];
  for(let i=0;i<2;i++){
   const id=randomUUID(),op=randomUUID(),original={...offlineSale,syncSaleId:id};
   assert.equal((await post(b.token,'sales',{operationId:op,saleId:id,version:1,recordedAt:otherAt,sale:original,refund:0})).status,201);
   isolated.prepare('INSERT INTO sales(client_id,payload) VALUES(?,?)').run(clientId,JSON.stringify(original));const localId=Number(isolated.prepare('SELECT last_insert_rowid() AS id').get()?.id);
   isolated.prepare('INSERT INTO identified_local_operations VALUES(?,?,?,?,?)').run(op,identity.commercialId,'sale',id,otherAt);
   const updated={...original,syncVersion:2,lines:original.lines.map(line=>({...line,quantity:line.quantity*2})),total:original.total*2,remaining:original.remaining*2};
   assert.equal((await post(a.token,'sales',{operationId:randomUUID(),saleId:id,version:2,recordedAt:'2026-11-07T13:00:00.000Z',sale:updated,refund:0})).status,201);twoSales.push({id,localId,updated});
  }
  assert.equal((await post(a.token,'sales',{operationId:randomUUID(),saleId:twoSales[1].id,version:3,recordedAt:'2026-11-07T13:30:00.000Z',sale:{...twoSales[1].updated,syncVersion:3},refund:0})).status,201);
  const firstPreview=await inspectTransport.inspectLocalSale(twoSales[0].localId,twoSales[0].id),secondPreview=await inspectTransport.inspectLocalSale(twoSales[1].localId,twoSales[1].id);
  const firstImport=await inspectTransport.reconcileLocalSale(twoSales[0].localId,twoSales[0].id,firstPreview.fingerprint);assert.equal(firstImport.versionsAdded,1);assert.equal(firstImport.balance,null);
  assert.equal((await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,clientId,digest))).conflict,true);
  await assert.rejects(isolatedTransaction(()=>prepareVerifiedPrototypeClose(isolatedTx,identity,'2026-11-06',0,randomUUID,digest)),/conflit|rapprochement/i);
  const secondImport=await inspectTransport.reconcileLocalSale(twoSales[1].localId,twoSales[1].id,secondPreview.fingerprint);assert.equal(secondImport.versionsAdded,2);assert.notEqual(secondImport.balance,null);
  const appended=isolated.prepare('SELECT previous_payload,new_payload FROM sale_revisions WHERE sale_id=? ORDER BY id').all(twoSales[1].localId) as {previous_payload:string;new_payload:string}[];assert.equal(appended.length,2);assert.ok(appended.every(r=>JSON.parse(r.previous_payload).id===twoSales[1].localId&&JSON.parse(r.new_payload).id===twoSales[1].localId));
  assert.equal((await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,clientId,digest))).conflict,false);


  // Course authentifiée : un avoir hors ligne vise une vente distante dont la
  // version change ensuite sur le premier appareil. Le refus conserve l'avoir
  // et n'empêche pas le commercial de travailler pour un autre client sain.
  const client3=randomUUID(),thirdSaleId=randomUUID();
  await db.query('INSERT INTO clients(id,name,opening_balance) VALUES($1,$2,0)',[client3,'Troisième client']);
  const thirdSale={...offlineSale,clientId:client3,clientName:'Troisième client',syncSaleId:thirdSaleId};
  assert.equal((await post(a.token,'sales',{operationId:randomUUID(),saleId:thirdSaleId,version:1,recordedAt:otherAt,sale:thirdSale,refund:0})).status,201);
  const refBeforeThird=await get('reference');await isolatedTransaction(()=>saveVerifiedCreditReference(isolatedTx,identity,identity,refBeforeThird,digest));
  const thirdSources=await get(`credit-sources/${client3}`);await isolatedTransaction(()=>saveCreditSourcesPrototype(isolatedTx,identity,identity,client3,thirdSources,digest));
  const thirdCommand={operationId:randomUUID(),invoiceId:thirdSaleId,expectedVersion:1,recordedAt:'2026-11-07T14:00:00.000Z',choice:null};
  const thirdReview=await isolatedTransaction(()=>previewLocalCredit(isolatedTx,identity,client3,'sale',thirdCommand,digest));
  await isolatedTransaction(()=>confirmLocalCreditReview(isolatedTx,identity,thirdReview,thirdCommand,digest));
  const thirdChanged={...thirdSale,syncVersion:2,clientName:'Troisième client modifié'};
  assert.equal((await post(a.token,'sales',{operationId:randomUUID(),saleId:thirdSaleId,version:2,recordedAt:'2026-11-07T13:30:00.000Z',sale:thirdChanged,refund:0})).status,201);
  const newerReference=await get('reference');await isolatedTransaction(()=>saveVerifiedCreditReference(isolatedTx,identity,identity,newerReference,digest));
  assert.equal((await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,client3,digest))).conflict,true);
  const unaffected=await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,clientId,digest));assert.equal(unaffected.conflict,false);
  await isolatedTransaction(()=>assertCreditWritePrototype(isolatedTx,{identity,expectedBalance:unaffected.balance},{kind:'sale',clientId},digest));
  assert.equal((await post(b.token,'credit-notes/sales',thirdCommand)).status,409);
  assert.equal(isolated.prepare('SELECT pending FROM offline_credit_prototype WHERE operation_id=?').get(thirdCommand.operationId)?.pending,1);
  await assert.rejects(isolatedTransaction(()=>readCreditJournalExportPrototype(isolatedTx,identity,otherDay,'Deuxième',digest)),/conflit|Remboursement enregistré ailleurs/);
  const abandonPayload={kind:'sale',command:thirdCommand};
  assert.equal((await post('invalid','credit-notes-abandon',abandonPayload)).status,401);
  const firstAbandon=await post(b.token,'credit-notes-abandon',abandonPayload);assert.equal(firstAbandon.status,200);const lostReceipt=await firstAbandon.json();assert.equal(lostReceipt.status,'abandoned');
  assert.equal((await post(a.token,'credit-notes-abandon',abandonPayload)).status,409);
  assert.equal((await post(b.token,'credit-notes/sales',thirdCommand)).status,409);
  assert.equal(isolated.prepare('SELECT pending FROM offline_credit_prototype WHERE operation_id=?').get(thirdCommand.operationId)?.pending,1);
  let expireAbandon=false;
  const creditAbandonTransport=createCreditTransportPrototype({id:second.id,name:'Deuxième',serverOrigin:identity.serverOrigin,token:b.token,expiresAt:new Date(Date.now()+3600000).toISOString()},identity,{
   request:(url,options)=>fetch(url.replace(identity.serverOrigin+'/api/mobile/identified',origin+'/v5'),options),
   cacheReference:async()=>{throw Error('inattendu');},cacheSources:async()=>{throw Error('inattendu');},synchronize:async()=>{throw Error('inattendu');},
   creditAbandon:{read:(id,op,guard)=>isolatedTransaction(async()=>{guard();return readPendingCreditAbandonPrototype(isolatedTx,id,op);}),
    resolve:(id,verified,note,response,reference,guard)=>isolatedTransaction(async()=>{guard();await resolveCreditAbandonPrototype(isolatedTx,id,verified,note,response,reference,digest);if(expireAbandon)throw Error('session expirée');guard();})}
  });
  const pendingThird=await isolatedTransaction(()=>readPendingCreditAbandonPrototype(isolatedTx,identity,thirdCommand.operationId));
  await assert.rejects(isolatedTransaction(()=>resolveCreditAbandonPrototype(isolatedTx,identity,identity,pendingThird,{...lostReceipt,invoiceId:randomUUID()},newerReference,digest)),/Accusé/);
  expireAbandon=true;await assert.rejects(creditAbandonTransport.abandonCredit(thirdCommand.operationId),/session expirée/);expireAbandon=false;
  assert.equal(isolated.prepare('SELECT count(*) AS n FROM credit_abandoned_note_prototype').get()?.n,0);
  assert.equal(isolated.prepare('SELECT pending FROM offline_credit_prototype WHERE operation_id=?').get(thirdCommand.operationId)?.pending,1);
  assert.equal(await creditAbandonTransport.abandonCredit(thirdCommand.operationId),'abandoned');
  assert.equal(isolated.prepare('SELECT count(*) AS n FROM offline_credit_prototype WHERE operation_id=?').get(thirdCommand.operationId)?.n,0);
  assert.equal((await isolatedTransaction(()=>readAbandonedCreditNotesPrototype(isolatedTx,identity)))[0].note.command.operationId,thirdCommand.operationId);
  isolated.exec('SAVEPOINT bad_note_archive');isolated.prepare('UPDATE credit_abandoned_note_prototype SET receipt=? WHERE operation_id=?').run('{}',thirdCommand.operationId);
  await assert.rejects(readAbandonedCreditNotesPrototype(isolatedTx,identity),/Archive d’avoir incohérente/);isolated.exec('ROLLBACK TO bad_note_archive; RELEASE bad_note_archive');
  assert.equal((await isolatedTransaction(()=>readPrototypeCreditBalance(isolatedTx,identity,client3,digest))).conflict,false);
  assert.equal((await post(b.token,'credit-notes/sales',thirdCommand)).status,409);

  }finally{isolated.close();}

 } finally {if(server)await new Promise<void>(r=>server!.close(()=>r()));mobile.close();firstPhone.close();}
}
