import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadJournalQueue, type JournalQueueItem } from '../../../apps/mobile/journal-upload.js';
const item = (sequence:number):JournalQueueItem => ({sequence,operationId:`op-${sequence}`,invoiceId:'invoice',version:sequence,payload:JSON.stringify({operationId:`op-${sequence}`,version:sequence,invoice:{id:'invoice'}})});
const ok = (id:string,status='received') => ({ok:true,status:200,json:async()=>({status,operationId:id})});

test('coupure avant réponse et renvoi : aucun accusé perdu ni double envoi des versions suivantes',async()=>{
 const pending=[item(1),item(2)]; const received=new Set<string>(); const calls:string[]=[]; let lost=true;
 const send=async (e:JournalQueueItem)=>{
  calls.push(e.operationId); const duplicate=received.has(e.operationId); received.add(e.operationId);
  if(lost) {lost=false;throw Error('Connexion perdue après réception');}
  return ok(e.operationId,duplicate?'duplicate':'received');
 };
 const ack=async (entry:JournalQueueItem)=>{const index=pending.findIndex(e=>e.operationId===entry.operationId);if(index>=0)pending.splice(index,1);};
 await assert.rejects(uploadJournalQueue([...pending],send,ack),/Connexion perdue/);
 assert.deepEqual(pending.map(e=>e.operationId),['op-1','op-2']);
 assert.equal(await uploadJournalQueue([...pending],send,ack),2);
 assert.deepEqual(calls,['op-1','op-1','op-2']);assert.equal(received.size,2);assert.equal(pending.length,0);
});

test('réponse incorrecte ou conflit : conserve la version et bloque les suivantes',async()=>{
 for (const response of [ok('autre'),ok('op-1','unknown'),{ok:true,status:200,json:async()=>{throw Error('JSON');}},{ok:false,status:409,json:async()=>({error:'Conflit de version'})}]) {
  const acked:string[]=[], calls:string[]=[];
  await assert.rejects(uploadJournalQueue([item(1),item(2)],async e=>{calls.push(e.operationId);return response;},async entry=>{acked.push(entry.operationId);}));
  assert.deepEqual(acked,[]);assert.deepEqual(calls,['op-1']);
 }
});

test('erreur d’accusé SQLite et ordre invalide : arrêt sans perte',async()=>{
 let sends=0;
 await assert.rejects(uploadJournalQueue([item(1),item(2)],async e=>{sends++;return ok(e.operationId);},async()=>{throw Error('SQLite');}),/SQLite/);
 assert.equal(sends,1);
 let invalidSends=0;
 await assert.rejects(uploadJournalQueue([item(2),item(1)],async e=>{invalidSends++;return ok(e.operationId);},async()=>{}),/incohérente/);
 assert.equal(invalidSends,0);
 const bad={...item(1),payload:JSON.stringify({operationId:'autre',version:1,invoice:{id:'invoice'}})};
 await assert.rejects(uploadJournalQueue([bad],async e=>ok(e.operationId),async()=>{}),/incohérents/);
});

test('accusé journal SQLite : entrée modifiée ou interrompue conservée',async()=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {acknowledgeJournalQueueEntry}=await import('../../../apps/mobile/journal-upload.js');
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE journal_sync_outbox(sequence INTEGER PRIMARY KEY,operation_id TEXT,invoice_id TEXT,version INTEGER,payload TEXT)');
  const first=item(1),second=item(2);for(const e of [first,second])db.prepare('INSERT INTO journal_sync_outbox VALUES(?,?,?,?,?)').run(e.sequence,e.operationId,e.invoiceId,e.version,e.payload);
  const tx={getFirstAsync:async<T>(sql:string,...p:(string|number|null)[])=>db.prepare(sql).get(...p) as T||null,runAsync:async(sql:string,...p:(string|number|null)[])=>{db.prepare(sql).run(...p)}};
  db.prepare('UPDATE journal_sync_outbox SET payload=? WHERE operation_id=?').run('{}',first.operationId);
  let sends=0;await assert.rejects(uploadJournalQueue([first,second],async e=>{sends++;return ok(e.operationId);},e=>acknowledgeJournalQueueEntry(tx,e)),/modifiée/);
  assert.equal(sends,1);assert.equal(db.prepare('SELECT count(*) AS n FROM journal_sync_outbox').get()?.n,2);
  db.prepare('UPDATE journal_sync_outbox SET payload=? WHERE operation_id=?').run(first.payload,first.operationId);
  for(const changed of [{...first,sequence:3},{...first,invoiceId:'autre'},{...first,version:2},{...first,operationId:'absent'}])await assert.rejects(acknowledgeJournalQueueEntry(tx,changed),/modifiée/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM journal_sync_outbox').get()?.n,2);
  db.exec('BEGIN');await acknowledgeJournalQueueEntry(tx,first);db.exec('ROLLBACK');assert.equal(db.prepare('SELECT count(*) AS n FROM journal_sync_outbox').get()?.n,2);
  await acknowledgeJournalQueueEntry(tx,first);assert.equal(db.prepare('SELECT count(*) AS n FROM journal_sync_outbox').get()?.n,1);
  await assert.rejects(acknowledgeJournalQueueEntry(tx,first),/modifiée/);
 }finally{db.close();}
});
