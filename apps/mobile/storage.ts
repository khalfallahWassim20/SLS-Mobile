import * as SQLite from 'expo-sqlite';
import { validatePreInvoiceReceipt,type FullCreditChoice } from '@sls/domain';
import { randomUUID, digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';
import { bootstrapJournalQueue, journalQueueSchema, queueJournalSnapshot } from './journal-queue';
import {saleEventTimeSchema,recordSaleEventTime} from './sale-event-time';
import {tourCloseQueueSchema,findTourCloseAttempt,acknowledgeTourClose,observeVerifiedTourState,type Attempt} from './tour-close-queue';
import {readIdentifiedOutbox,acknowledgeIdentifiedOutbox} from './identified-outbox';
import type {IdentifiedEntry} from './identified-upload';
import {identifiedDeviceSchema,getDeviceIdentity,bindVerifiedDevice,saveVerifiedIdentifiedReference,assertDeviceWritable,recordDeviceOperation,assertKnownDeviceEntity,type DeviceIdentity} from './identified-device';
import {validateIdentifiedReference} from './identified-reference';
import {tunisDay} from './journal';
import {resetLocalTestOperations} from './reset-test-operations';
import {offlineCreditPrototypeSchema,prepareOfflineCreditPrototype,readAllOfflineCreditPrototype,readReadyOfflineCreditPrototype,acknowledgeOfflineCreditPrototype,type Kind,type Note} from './credit-note-offline-prototype';
import {assertNoLocalCreditNote,assertNoRemoteCreditNote} from './credit-note-local-guard';
import {creditReferencePrototypeSchema,readPrototypeCreditReferenceCache} from './credit-note-reference-cache-prototype';
import {saveVerifiedCreditReference} from './credit-note-sync-reference';
import {syncCreditPrototype} from './credit-note-sync-prototype';
import {saveAndVerifyFinalCreditReference} from './credit-note-sync-final-prototype';
import {preparePrototypeClose} from './credit-note-close-prototype';
import {readPrototypeCreditBalance,prepareBalancedLocalCredit} from './credit-note-balance-storage-prototype';
import {previewLocalCredit,confirmLocalCreditReview,type CreditReview} from './credit-note-review-prototype';
import {creditSourcesPrototypeSchema,saveCreditSourcesPrototype,readCreditSourcesPrototype} from './credit-note-sources-prototype';
import {createCreditTransportPrototype} from './credit-note-transport-prototype';
import {readCreditSourceChoices} from './credit-note-source-choices-prototype';
import {readCreditJournalExportPrototype} from './credit-note-journal-export-prototype';
import {describeCreditJournalPrototype} from './credit-note-journal-view-model-prototype';
import {assertLegacyMobileCreditSafe,assertCreditWritePrototype,assertCreditReceiptPrototype,type CreditWriteContext} from './credit-note-write-guard-prototype';
import {bindAndCacheCreditReferencePrototype} from './credit-note-binding-prototype';
import {readCreditClientsPrototype} from './credit-client-view-prototype';
import type {CommercialSession} from './commercial-login';

export type SavedSale = {
  id: number; createdAt: string; clientId: string; clientName: string; syncSaleId?: string; syncVersion?: number;
  lines: { name: string; code: string; quantity: number; unitPrice: number; discount: number; vat: number }[];
  total: number; paid: number; remaining: number; paymentMode: string;
  chequeNumber: string; chequeBank: string; chequeDue: string;
};
let database: Promise<SQLite.SQLiteDatabase> | undefined;
async function db() {
  if (!database) database = SQLite.openDatabaseAsync('sls-demo.db').then(async instance => {
    await instance.execAsync(`PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
      client_id TEXT NOT NULL, payload TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS sale_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL, created_at TEXT NOT NULL,
      previous_payload TEXT NOT NULL, new_payload TEXT NOT NULL, refund INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, client_id TEXT NOT NULL, payload TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS sales_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, sale_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, last_error TEXT
    ); CREATE TABLE IF NOT EXISTS tour_pre_invoices (
      id TEXT PRIMARY KEY, journal_date TEXT NOT NULL, client_id TEXT NOT NULL,
      payload TEXT NOT NULL, UNIQUE(journal_date, client_id)
    ); CREATE TABLE IF NOT EXISTS tour_journal_receipts (
      id TEXT PRIMARY KEY, pre_invoice_id TEXT NOT NULL, client_id TEXT NOT NULL, journal_date TEXT NOT NULL, payload TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS reference_snapshot (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); ${journalQueueSchema} ${saleEventTimeSchema} ${tourCloseQueueSchema} ${identifiedDeviceSchema} ${offlineCreditPrototypeSchema} ${creditReferencePrototypeSchema} ${creditSourcesPrototypeSchema}`);
    return instance;
  }).catch(error => { database = undefined; throw error; });
  return database;
}
export async function getSales(): Promise<SavedSale[]> {
  const rows = await (await db()).getAllAsync<{ id: number; payload: string }>('SELECT id, payload FROM sales ORDER BY id DESC');
  return rows.map(row => ({ ...JSON.parse(row.payload), id: row.id } as SavedSale));
}
export async function saveSale(sale: Omit<SavedSale, 'id'>, syncEligible = false, credit?:CreditWriteContext): Promise<void> {
  const database = await db();
  await database.withExclusiveTransactionAsync(async tx => {
    const identity=await getDeviceIdentity(tx);
    if(credit){if(!syncEligible)throw Error('Vente v5 non synchronisable.');await assertCreditWritePrototype(tx,credit,{kind:'sale',clientId:sale.clientId},data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data));}else await assertLegacyMobileCreditSafe(tx,identity);
    await assertDeviceWritable(tx,identity,[tunisDay(new Date(sale.createdAt))]);
    if(identity && !syncEligible)throw new Error('Vente non synchronisable : actualisez les données.');
    const snapshot = syncEligible ? { ...sale, syncSaleId: randomUUID(), syncVersion: 1 } : sale;
    await tx.runAsync('INSERT INTO sales (created_at, client_id, payload) VALUES (?, ?, ?)', snapshot.createdAt, snapshot.clientId, JSON.stringify(snapshot));
    if (snapshot.syncSaleId) {
      const operationId = randomUUID();
      const event = { operationId, saleId: snapshot.syncSaleId, version: 1, sale: snapshot, refund: 0 };
      await tx.runAsync('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)', operationId, snapshot.syncSaleId, 1, JSON.stringify(event));
      await recordSaleEventTime(tx,operationId,snapshot.createdAt);
      await recordDeviceOperation(tx,identity,operationId,'sale',snapshot.syncSaleId,snapshot.createdAt);
    }
  });
}

export type Revision = { id: number; createdAt: string; previous: SavedSale; current: SavedSale; refund: number };
export async function getRevisions(saleId: number): Promise<Revision[]> {
  const rows = await (await db()).getAllAsync<{id: number; created_at: string; previous_payload: string; new_payload: string; refund: number}>(
    'SELECT id, created_at, previous_payload, new_payload, refund FROM sale_revisions WHERE sale_id = ? ORDER BY id DESC', saleId);
  return rows.map(r => ({ id: r.id, createdAt: r.created_at, previous: JSON.parse(r.previous_payload), current: JSON.parse(r.new_payload), refund: r.refund }));
}
export async function updateSale(previous: SavedSale, updated: SavedSale, refund: number, credit?:CreditWriteContext): Promise<void> {
  const database = await db();
  await database.withExclusiveTransactionAsync(async tx => {
    await assertNoLocalCreditNote(tx,'sale',previous.syncSaleId);
    const row = await tx.getFirstAsync<{payload: string}>('SELECT payload FROM sales WHERE id = ?', previous.id);
    if (!row || JSON.stringify({ ...JSON.parse(row.payload), id: previous.id }) !== JSON.stringify(previous)) throw new Error('La vente a changé. Veuillez rouvrir son détail.');
    const recordedAt=new Date().toISOString(),identity=await getDeviceIdentity(tx);
    if(credit){if(previous.clientId!==updated.clientId)throw Error('Client de la facture modifié.');await assertCreditWritePrototype(tx,credit,{kind:'edit',clientId:previous.clientId},data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data));}else await assertLegacyMobileCreditSafe(tx,identity);
    await assertNoRemoteCreditNote(tx,identity,'sale',previous.syncSaleId);
    await assertDeviceWritable(tx,identity,[tunisDay(new Date(previous.createdAt)),tunisDay(new Date(recordedAt))]);
    await assertKnownDeviceEntity(tx,identity,'sale',previous.syncSaleId,{clientId:previous.clientId,version:previous.syncVersion??0,total:previous.total,paid:previous.paid});
    const { id: _id, ...originalPayload } = updated;
    const payload = previous.syncSaleId ? { ...originalPayload, syncVersion: (previous.syncVersion ?? 1) + 1 } : originalPayload;
    const json = JSON.stringify(payload);
    await tx.runAsync('UPDATE sales SET payload = ? WHERE id = ?', json, previous.id);
    const persisted = { ...payload, id: previous.id };
    await tx.runAsync('INSERT INTO sale_revisions (sale_id, created_at, previous_payload, new_payload, refund) VALUES (?, ?, ?, ?, ?)', previous.id, recordedAt, JSON.stringify(previous), JSON.stringify(persisted), refund);
    if (previous.syncSaleId) {
      const operationId = randomUUID();
      const event = { operationId, saleId: previous.syncSaleId, version: payload.syncVersion, sale: payload, refund };
      await tx.runAsync('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)', operationId, previous.syncSaleId, payload.syncVersion!, JSON.stringify(event));
      await recordSaleEventTime(tx,operationId,recordedAt);
      await recordDeviceOperation(tx,identity,operationId,'sale',previous.syncSaleId,recordedAt);
    }
  });
}

export type Settlement = { id: number; syncOperationId?: string; createdAt: string; clientId: string; clientName: string; amount: number; mode: string; chequeNumber: string; chequeBank: string; chequeDue: string };
export async function getSettlements(): Promise<Settlement[]> {
  const rows = await (await db()).getAllAsync<{id: number; payload: string}>('SELECT id, payload FROM settlements ORDER BY id DESC');
  return rows.map(r => ({ ...JSON.parse(r.payload), id: r.id }));
}
export async function saveSettlement(settlement: Omit<Settlement, 'id'>, syncEligible = false, credit?:CreditWriteContext): Promise<void> {
  const database = await db();
  await database.withExclusiveTransactionAsync(async tx => {
    const identity=await getDeviceIdentity(tx);
    if(credit){if(!syncEligible)throw Error('Règlement v5 non synchronisable.');await assertCreditWritePrototype(tx,credit,{kind:'settlement',clientId:settlement.clientId,amount:settlement.amount},data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data));}else await assertLegacyMobileCreditSafe(tx,identity);
    await assertDeviceWritable(tx,identity,[tunisDay(new Date(settlement.createdAt))]);
    if(identity && !syncEligible)throw new Error('Règlement non synchronisable : actualisez les données.');
    const syncOperationId = syncEligible ? randomUUID() : undefined;
    const snapshot = syncOperationId ? { ...settlement, syncOperationId } : settlement;
    await tx.runAsync('INSERT INTO settlements (created_at, client_id, payload) VALUES (?, ?, ?)', snapshot.createdAt, snapshot.clientId, JSON.stringify(snapshot));
    if (syncOperationId) {
      const event = { operationId: syncOperationId, settlement: snapshot };
      await tx.runAsync('INSERT INTO sales_outbox(operation_id,sale_id,version,payload) VALUES(?,?,?,?)', syncOperationId, syncOperationId, 1, JSON.stringify(event));
      await recordDeviceOperation(tx,identity,syncOperationId,'settlement',syncOperationId,snapshot.createdAt);
    }
  });
}
// La première version sauvegardée de chaque vente conserve le paiement initial,
// y compris après remboursement. Pour une vente non modifiée, le payload actuel suffit.
export async function getOriginalSales(): Promise<SavedSale[]> {
  const rows = await (await db()).getAllAsync<{id: number; payload: string}>(`SELECT s.id, COALESCE(
    (SELECT r.previous_payload FROM sale_revisions r WHERE r.sale_id = s.id ORDER BY r.id ASC LIMIT 1), s.payload
  ) AS payload FROM sales s`);
  return rows.map(r => ({ ...JSON.parse(r.payload), id: r.id }));
}

// Un seul instantané complet : une panne avant le commit conserve l'ancien.
export async function saveReference(payload: string): Promise<void> {
  const database = await db();
  await database.execAsync('CREATE TABLE IF NOT EXISTS reference_snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL)');
  await database.runAsync('INSERT INTO reference_snapshot (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', payload);
}
export async function getReference(): Promise<string | null> {
  const database = await db();
  await database.execAsync('CREATE TABLE IF NOT EXISTS reference_snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL)');
  const row = await database.getFirstAsync<{ payload: string }>('SELECT payload FROM reference_snapshot WHERE id=1');
  return row?.payload ?? null;
}

export type OutboxEntry = { sequence: number; operationId: string; saleId: string; version: number; payload: string; lastError: string | null };
export async function getOutbox(): Promise<OutboxEntry[]> {
 return (await db()).getAllAsync<OutboxEntry>('SELECT sequence, operation_id AS operationId, sale_id AS saleId, version, payload, last_error AS lastError FROM sales_outbox ORDER BY sequence');
}
export async function acknowledgeOutbox(operationId: string): Promise<void> {
 await (await db()).runAsync('DELETE FROM sales_outbox WHERE operation_id = ?', operationId);
}
export async function failOutbox(operationId: string, error: string): Promise<void> {
 await (await db()).runAsync('UPDATE sales_outbox SET last_error = ? WHERE operation_id = ?', error.slice(0, 300), operationId);
}

export type TourPreInvoice = { id: string; journalDate: string; clientId: string; clientName: string; sector: string; amount: number; createdAt: string };
export async function getPreInvoices(journalDate: string): Promise<TourPreInvoice[]> {
 const database = await db();
 await database.execAsync(`CREATE TABLE IF NOT EXISTS tour_pre_invoices (
   id TEXT PRIMARY KEY, journal_date TEXT NOT NULL, client_id TEXT NOT NULL,
   payload TEXT NOT NULL, UNIQUE(journal_date, client_id)
 )`);
 const rows = await database.getAllAsync<{payload: string}>('SELECT payload FROM tour_pre_invoices WHERE journal_date = ? ORDER BY rowid', journalDate);
 return rows.map(row => JSON.parse(row.payload));
}
export async function savePreInvoice(value: Omit<TourPreInvoice, 'id'>, credit?:CreditWriteContext): Promise<void> {
 if (!value.clientId || !value.clientName || !Number.isSafeInteger(value.amount) || value.amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(value.journalDate)) throw new Error('Saisie invalide.');
 const database = await db();
 await getPreInvoices(value.journalDate); // initialise la table avant l'écriture
 const id = randomUUID(), payload = { ...value, id };
 try { await database.withExclusiveTransactionAsync(async tx => {
   const identity=await getDeviceIdentity(tx);
   if(credit)await assertCreditWritePrototype(tx,credit,{kind:'preinvoice',clientId:value.clientId,day:value.journalDate},data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data));else await assertLegacyMobileCreditSafe(tx,identity);
   await assertDeviceWritable(tx,identity,[value.journalDate]);
   await tx.runAsync('INSERT INTO tour_pre_invoices (id,journal_date,client_id,payload) VALUES (?,?,?,?)', id, value.journalDate, value.clientId, JSON.stringify(payload));
   const operationId=await queueJournalSnapshot(tx,id,randomUUID);
   await recordDeviceOperation(tx,identity,operationId,'journal',id,value.createdAt);
 }); }
 catch (error) {
   const existing = await database.getFirstAsync<{id: string}>('SELECT id FROM tour_pre_invoices WHERE journal_date=? AND client_id=?', value.journalDate, value.clientId);
   if (existing) throw new Error('Une facture préétablie existe déjà pour ce client aujourd’hui.');
   throw error;
 }
}

export type TourJournalReceipt = { id: string; preInvoiceId: string; clientId: string; journalDate: string; createdAt: string; prePaid: number; oldDebtPaid: number; creditFull: boolean; mode: 'Espèces' | 'Chèque' | 'Virement'; chequeNumber: string; chequeBank: string; chequeDue: string; oldDebtLimitAtStart: number };
async function ensureJournalReceipts() {
 const database = await db();
 await database.execAsync(`CREATE TABLE IF NOT EXISTS tour_journal_receipts (
   id TEXT PRIMARY KEY, pre_invoice_id TEXT NOT NULL, client_id TEXT NOT NULL, journal_date TEXT NOT NULL, payload TEXT NOT NULL
 )`);
 return database;
}
export async function getAllPreInvoices(): Promise<TourPreInvoice[]> {
 const database = await db();
 await database.withExclusiveTransactionAsync(async tx => { const missing=await tx.getFirstAsync<{n:number}>('SELECT EXISTS(SELECT 1 FROM tour_pre_invoices p LEFT JOIN journal_sync_state s ON s.invoice_id=p.id WHERE s.invoice_id IS NULL) AS n');if(!missing)throw Error('État du journal indisponible.');if(missing.n){await assertLegacyMobileCreditSafe(tx,await getDeviceIdentity(tx));await bootstrapJournalQueue(tx,randomUUID);} });
 const rows = await database.getAllAsync<{payload:string}>('SELECT payload FROM tour_pre_invoices ORDER BY rowid');
 return rows.map(r => JSON.parse(r.payload));
}
export async function getTourReceipts(): Promise<TourJournalReceipt[]> {
 const database = await ensureJournalReceipts();
 const rows = await database.getAllAsync<{payload:string}>('SELECT payload FROM tour_journal_receipts ORDER BY rowid');
 return rows.map(r => JSON.parse(r.payload));
}
export async function saveTourReceipt(value: Omit<TourJournalReceipt,'id'>, availableOldDebt: number, credit?:CreditWriteContext): Promise<void> {
 const database = await ensureJournalReceipts();
 await database.withExclusiveTransactionAsync(async tx => {
   const identity=await getDeviceIdentity(tx);
   const creditBalance=credit?await assertCreditWritePrototype(tx,credit,{kind:'receipt',clientId:value.clientId},data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data)):null;
   if(!credit)await assertLegacyMobileCreditSafe(tx,identity);
   await assertDeviceWritable(tx,identity,[value.journalDate]);
   await assertNoLocalCreditNote(tx,'preinvoice',value.preInvoiceId);
   await assertNoRemoteCreditNote(tx,identity,'preinvoice',value.preInvoiceId);
   const state = await tx.getFirstAsync<{version:number;payload:string}>('SELECT version,payload FROM journal_sync_state WHERE invoice_id=?', value.preInvoiceId);
   await assertKnownDeviceEntity(tx,identity,'journal',value.preInvoiceId,undefined,state ? {...state,digest:(text:string)=>digestStringAsync(CryptoDigestAlgorithm.SHA256,text)} : undefined);
   const raw = await tx.getFirstAsync<{payload:string}>('SELECT payload FROM tour_pre_invoices WHERE id=? AND client_id=? AND journal_date=?', value.preInvoiceId, value.clientId, value.journalDate);
   if (!raw) throw new Error('Facture préétablie introuvable.');
   const invoice: TourPreInvoice = JSON.parse(raw.payload);
   const previousRows = await tx.getAllAsync<{payload:string}>('SELECT payload FROM tour_journal_receipts WHERE pre_invoice_id=? ORDER BY rowid', value.preInvoiceId);
   const previous: TourJournalReceipt[] = previousRows.map(r => JSON.parse(r.payload));
   if (previous.length && value.oldDebtLimitAtStart !== previous[0].oldDebtLimitAtStart) throw new Error('Ancienne dette incohérente.');
   if (!Number.isSafeInteger(value.oldDebtLimitAtStart) || value.oldDebtLimitAtStart < 0) throw new Error('Ancienne dette invalide.');
   const priorDebtPaid = previous.reduce((n,p) => n+p.oldDebtPaid, 0);
   const bound = creditBalance ? assertCreditReceiptPrototype(creditBalance.balance,invoice.amount,previous,value) : Math.min(availableOldDebt, Math.max(0,value.oldDebtLimitAtStart-priorDebtPaid));
   if (!['Espèces','Chèque','Virement'].includes(value.mode)) throw new Error('Mode de paiement invalide.');
   if (value.mode === 'Chèque' && (value.prePaid || value.oldDebtPaid) && (!value.chequeNumber.trim() || !value.chequeBank.trim() || !value.chequeDue.trim())) throw new Error('Renseignez le numéro, la banque et l’échéance du chèque.');
   validatePreInvoiceReceipt(invoice.amount, previous, value, bound);
   if (!state && identity) throw new Error('Historique identifié incomplet : rapprochement nécessaire.');
   if (!state) await queueJournalSnapshot(tx,value.preInvoiceId,randomUUID);
   const id = randomUUID();
   await tx.runAsync('INSERT INTO tour_journal_receipts(id,pre_invoice_id,client_id,journal_date,payload) VALUES (?,?,?,?,?)', id,value.preInvoiceId,value.clientId,value.journalDate,JSON.stringify({...value,id}));
   const operationId=await queueJournalSnapshot(tx,value.preInvoiceId,randomUUID);
   await recordDeviceOperation(tx,identity,operationId,'journal',value.preInvoiceId,value.createdAt);
 });
}

// File distincte des ventes ; un accusé ne supprime que la version reçue.
export type JournalOutboxEntry = { sequence:number; operationId:string; invoiceId:string; version:number; payload:string };
export async function getJournalOutbox(): Promise<JournalOutboxEntry[]> {
 return (await db()).getAllAsync<JournalOutboxEntry>('SELECT sequence,operation_id AS operationId,invoice_id AS invoiceId,version,payload FROM journal_sync_outbox ORDER BY sequence');
}
export async function acknowledgeJournalOutbox(operationId:string): Promise<void> {
 await (await db()).runAsync('DELETE FROM journal_sync_outbox WHERE operation_id=?',operationId);
}

/** Tant que l'envoi individuel n'est pas activé, ne pas envoyer une file liée via le jeton partagé. */
export async function isIdentifiedDeviceBound():Promise<boolean> {return !!(await getDeviceIdentity(await db()));}

/** La session et la référence sont vérifiées en ligne par l'appelant. La liaison et les
 * deux caches sont enregistrés ensemble ou pas du tout. */
export async function bindAndCacheIdentified(identity:DeviceIdentity,reference:unknown):Promise<void> {
 const parsed=validateIdentifiedReference(reference),database=await db();
 await database.execAsync('CREATE TABLE IF NOT EXISTS reference_snapshot (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL)');
 await database.withExclusiveTransactionAsync(async tx=>{
  await bindVerifiedDevice(tx,identity);
  await saveVerifiedIdentifiedReference(tx,identity,identity,parsed);
  const snapshot={...parsed,version:3,syncedAt:new Date().toISOString()};
  await tx.runAsync('INSERT INTO reference_snapshot(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',JSON.stringify(snapshot));
 });
}
export async function getBoundIdentity():Promise<DeviceIdentity|null> {return getDeviceIdentity(await db());}
export async function getIdentifiedOutbox(identity:DeviceIdentity):Promise<IdentifiedEntry[]> {
 const database=await db();let entries:IdentifiedEntry[]=[];
 await database.withExclusiveTransactionAsync(async tx=>{entries=await readIdentifiedOutbox(tx,identity);});return entries;
}
export async function acknowledgeIdentifiedEntry(identity:DeviceIdentity,entry:IdentifiedEntry):Promise<void> {
 const database=await db();await database.withExclusiveTransactionAsync(async tx=>{await acknowledgeIdentifiedOutbox(tx,identity,entry);});
}
async function checkIdentity(tx:SQLite.SQLiteDatabase,identity:DeviceIdentity):Promise<void> {
 const current=await getDeviceIdentity(tx);
 if(!current||current.commercialId!==identity.commercialId||current.serverOrigin!==identity.serverOrigin)throw Error('Identité ou serveur du téléphone incohérent.');
}
export async function observeIdentifiedTour(identity:DeviceIdentity,day:string,state:unknown):Promise<void> {
 const database=await db();await database.withExclusiveTransactionAsync(async tx=>{await checkIdentity(tx,identity);await observeVerifiedTourState(tx,identity.commercialId,day,state);});
}
export async function getLocalCloseAttempt(identity:DeviceIdentity,day:string):Promise<Attempt|null> {
 const database=await db();let result:Attempt|null=null;
 await database.withExclusiveTransactionAsync(async tx=>{await checkIdentity(tx,identity);result=await findTourCloseAttempt(tx,identity.commercialId,day);});return result;
}
export async function prepareLocalClose(identity:DeviceIdentity,day:string,version:number,creditAware=false):Promise<Attempt> {
 const database=await db();let result:Attempt|undefined;
 await database.withExclusiveTransactionAsync(async tx=>{await checkIdentity(tx,identity);if(!creditAware)await assertLegacyMobileCreditSafe(tx,identity);result=await preparePrototypeClose(tx,identity,day,version,randomUUID);});return result!;
}
export async function acknowledgeLocalClose(identity:DeviceIdentity,day:string,response:unknown):Promise<void> {
 const database=await db();await database.withExclusiveTransactionAsync(async tx=>{await checkIdentity(tx,identity);await acknowledgeTourClose(tx,identity.commercialId,day,response);});
}

/** Accès transactionnels préparatoires, non utilisés par les écrans ni l'envoi.
 * L'activation exige d'abord le raccordement du solde et de la référence serveur. */
export async function createLocalCreditPrototype(identity:DeviceIdentity,kind:Kind,invoiceId:string,expectedVersion:number,choice:FullCreditChoice|null):Promise<Note> {
 const database=await db();let result:Note|undefined;
 await database.withExclusiveTransactionAsync(async tx=>{result=await prepareOfflineCreditPrototype(tx,identity,kind,{operationId:randomUUID(),invoiceId,expectedVersion,recordedAt:new Date().toISOString(),choice});});
 return result!;
}
export async function getLocalCreditPrototypes(identity:DeviceIdentity):Promise<{note:Note;pending:boolean}[]> {
 const database=await db();let result:{note:Note;pending:boolean}[]=[];
 await database.withExclusiveTransactionAsync(async tx=>{result=await readAllOfflineCreditPrototype(tx,identity);});return result;
}
export async function getReadyLocalCreditPrototypes(identity:DeviceIdentity):Promise<Note[]> {
 const database=await db();let result:Note[]=[];
 await database.withExclusiveTransactionAsync(async tx=>{result=await readReadyOfflineCreditPrototype(tx,identity);});return result;
}
export async function acknowledgeLocalCreditPrototype(identity:DeviceIdentity,note:Note,response:unknown):Promise<void> {
 const database=await db();await database.withExclusiveTransactionAsync(async tx=>{await acknowledgeOfflineCreditPrototype(tx,identity,note,response);});
}

/** Référence future non reliée au cache ni aux écrans actuels. */
export async function cacheCreditReferencePrototype(identity:DeviceIdentity,verified:DeviceIdentity,value:unknown,guard:()=>void=()=>{}):Promise<void> {
 const database=await db();await database.withExclusiveTransactionAsync(async tx=>{guard();await saveVerifiedCreditReference(tx,identity,verified,value,data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data));guard();});
}
export async function getCreditReferencePrototype(identity:DeviceIdentity) {
 const database=await db();let result:Awaited<ReturnType<typeof readPrototypeCreditReferenceCache>>=null;
 await database.withExclusiveTransactionAsync(async tx=>{result=await readPrototypeCreditReferenceCache(tx,identity);});return result;
}

/** Copies distantes isolées ; ne pas les mélanger aux vues actuelles v3. */
export async function cacheCreditSourcesPrototype(identity:DeviceIdentity,verified:DeviceIdentity,clientId:string,value:unknown,guard:()=>void=()=>{}) {
 const database=await db();await database.withExclusiveTransactionAsync(async tx=>{guard();await saveCreditSourcesPrototype(tx,identity,verified,clientId,value,data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data));guard();});
}
export async function getCreditSourcesPrototype(identity:DeviceIdentity,clientId:string) {
 const database=await db();let result:Awaited<ReturnType<typeof readCreditSourcesPrototype>>=null;
 await database.withExclusiveTransactionAsync(async tx=>{result=await readCreditSourcesPrototype(tx,identity,clientId,data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data));});return result;
}

/** Liste préparatoire sans fusion avec les tables du journal actif. */
export async function getCreditSourceChoicesPrototype(identity:DeviceIdentity,clientId:string) {
 const database=await db();let result:Awaited<ReturnType<typeof readCreditSourceChoices>>|undefined;
 await database.withExclusiveTransactionAsync(async tx=>{result=await readCreditSourceChoices(tx,identity,clientId,data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data));});return result!;
}

/** Effacement explicite des données fictives de ce téléphone seulement. */
export async function clearLocalTestOperations():Promise<void> {
 const database=await db();await database.withExclusiveTransactionAsync(async tx=>{await resetLocalTestOperations(tx);});
}

/** Préparatoire seulement : ne pas utiliser pour autoriser une opération avant
 * l'activation coordonnée du protocole d'avoirs et de toutes ses protections. */
export async function getPrototypeCreditBalance(identity:DeviceIdentity,clientId:string) {
 const database=await db();
 let result:Awaited<ReturnType<typeof readPrototypeCreditBalance>>|undefined;
 await database.withExclusiveTransactionAsync(async tx=>{result=await readPrototypeCreditBalance(tx,identity,clientId,data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data));});
 return result!;
}

/** Préparation transactionnelle non exposée dans l'application. */
export async function createBalancedLocalCreditPrototype(identity:DeviceIdentity,clientId:string,kind:Kind,invoiceId:string,expectedVersion:number,choice:FullCreditChoice|null) {
 const database=await db();
 let result:Awaited<ReturnType<typeof prepareBalancedLocalCredit>>|undefined;
 await database.withExclusiveTransactionAsync(async tx=>{result=await prepareBalancedLocalCredit(tx,identity,clientId,kind,{operationId:randomUUID(),invoiceId,expectedVersion,recordedAt:new Date().toISOString(),choice},data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data));});
 return result!;
}

/** Aperçu et confirmation préparatoires. Aucun écran ne les appelle encore. */
export async function previewCreditReviewPrototype(identity:DeviceIdentity,clientId:string,kind:Kind,invoiceId:string,expectedVersion:number,choice:FullCreditChoice|null) {
 const database=await db();let result:CreditReview|undefined;
 await database.withExclusiveTransactionAsync(async tx=>{result=await previewLocalCredit(tx,identity,clientId,kind,{operationId:randomUUID(),invoiceId,expectedVersion,recordedAt:new Date().toISOString(),choice},data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data));});
 return result!;
}
export async function confirmCreditReviewPrototype(identity:DeviceIdentity,preview:CreditReview) {
 const database=await db();let result:Awaited<ReturnType<typeof confirmLocalCreditReview>>|undefined;
 await database.withExclusiveTransactionAsync(async tx=>{result=await confirmLocalCreditReview(tx,identity,preview,{operationId:randomUUID(),invoiceId:preview.invoiceId,expectedVersion:preview.expectedVersion,recordedAt:new Date().toISOString(),choice:preview.choice},data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data));});
 return result!;
}

/** Connecteur de synchronisation préparatoire, non appelé par l'interface.
 * Le transport doit authentifier la session et cibler un serveur compatible v5. */
let creditSyncRunning=false;
export async function synchronizeCreditPrototype(identity:DeviceIdentity,verified:DeviceIdentity,transport:{
 fetchReference:()=>Promise<unknown>;
 sendOperation:(path:string,body:string)=>Promise<{ok:boolean;status:number;json:()=>Promise<unknown>}>;
 sendCredit:(path:string,body:string)=>Promise<{ok:boolean;status:number;json:()=>Promise<unknown>}>;
},guard:()=>void=()=>{}) {
 if(creditSyncRunning)throw Error('Synchronisation déjà en cours.');
 creditSyncRunning=true;
 try {
  return await syncCreditPrototype(identity,verified,{
   readOperations:()=>getIdentifiedOutbox(identity),acknowledgeOperation:async entry=>{const database=await db();await database.withExclusiveTransactionAsync(async tx=>{guard();await acknowledgeIdentifiedOutbox(tx,identity,entry);guard();});},
   readReadyCredits:()=>getReadyLocalCreditPrototypes(identity),readAllCredits:()=>getLocalCreditPrototypes(identity),
   acknowledgeCredit:async(note,response)=>{const database=await db();await database.withExclusiveTransactionAsync(async tx=>{guard();await acknowledgeOfflineCreditPrototype(tx,identity,note,response);guard();});},
   sendOperation:transport.sendOperation,sendCredit:transport.sendCredit,fetchReference:transport.fetchReference,
   saveReference:(id,session,value)=>cacheCreditReferencePrototype(id,session,value,guard),
   saveFinalReference:async(id,session,value)=>{const database=await db();await database.withExclusiveTransactionAsync(async tx=>{guard();await saveAndVerifyFinalCreditReference(tx,id,session,value,data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data));guard();});}
  });
 } finally {creditSyncRunning=false;}
}

/** Point de raccordement préparatoire ; aucune interface actuelle ne l'appelle.
 * Le jeton reste en mémoire et le téléphone doit déjà être lié. */
export function createExperimentalCreditMobileTransport(session:CommercialSession,identity:DeviceIdentity,onUnauthorized:()=>void) {
 return createCreditTransportPrototype(session,identity,{
  request:(url,options)=>fetch(url,options),onUnauthorized,
  cacheReference:cacheCreditReferencePrototype,cacheSources:cacheCreditSourcesPrototype,
  bindReference:async(id,verified,value,guard)=>{const database=await db();await database.withExclusiveTransactionAsync(tx=>bindAndCacheCreditReferencePrototype(tx,id,verified,value,data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data),guard));},
  synchronize:synchronizeCreditPrototype,
  tour:{
   getAttempt:async(id,day,guard)=>{const database=await db();let result:Attempt|null=null;await database.withExclusiveTransactionAsync(async tx=>{guard();await checkIdentity(tx,id);result=await findTourCloseAttempt(tx,id.commercialId,day);guard();});return result;},
   prepare:async(id,day,version,guard)=>{const database=await db();let result:Attempt|undefined;await database.withExclusiveTransactionAsync(async tx=>{guard();result=await preparePrototypeClose(tx,id,day,version,randomUUID);guard();});return result!;},
   acknowledge:async(id,day,response,guard)=>{const database=await db();await database.withExclusiveTransactionAsync(async tx=>{guard();await checkIdentity(tx,id);await acknowledgeTourClose(tx,id.commercialId,day,response);guard();});},
   observe:async(id,day,response,guard)=>{const database=await db();await database.withExclusiveTransactionAsync(async tx=>{guard();await checkIdentity(tx,id);await observeVerifiedTourState(tx,id.commercialId,day,response);guard();});}
  }
 });
}

/** Export v5 préparatoire : capture atomique, non raccordée à l'écran v3. */
export async function getCreditJournalExportPrototype(identity:DeviceIdentity,day:string,commercial:string) {
 const database=await db();let result:Awaited<ReturnType<typeof readCreditJournalExportPrototype>>|undefined;
 await database.withExclusiveTransactionAsync(async tx=>{result=await readCreditJournalExportPrototype(tx,identity,day,commercial,data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data));});return result!;
}

/** Modèle de journal et export issus d'une seule capture vérifiée ; le rendu
 * ne doit pas être combiné avec les soldes et actions v3. */
export async function getCreditJournalViewPrototype(identity:DeviceIdentity,day:string,commercial:string) {
 const snapshot=await getCreditJournalExportPrototype(identity,day,commercial);
 return {snapshot,view:describeCreditJournalPrototype(snapshot)};
}

/** Clients, soldes et articles v5 sur un seul instantané ; les écrans v3 ne
 * doivent jamais utiliser ou réduire ce résultat. */
export async function getCreditClientsPrototype(identity:DeviceIdentity) {
 const database=await db();let result:Awaited<ReturnType<typeof readCreditClientsPrototype>>|undefined;
 await database.withExclusiveTransactionAsync(async tx=>{result=await readCreditClientsPrototype(tx,identity,data=>digestStringAsync(CryptoDigestAlgorithm.SHA256,data));});return result!;
}
