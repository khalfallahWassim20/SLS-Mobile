import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {auditStoredCreditNotes} from '../../../apps/api/src/credit-note-audit-read.js';
import {prepareFullCreditNote} from '../src/credit-note-command.ts';
test('audit des avoirs : lecture SQL réelle, base saine puis mouvement altéré',async()=>{
 const db=new PGlite();
 try{
  await db.exec(schemaSql);
  const actor={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',role:'commercial' as const},command={operationId:'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',invoiceId:'cccccccc-cccc-4ccc-8ccc-000000000001',expectedVersion:1,recordedAt:'2026-01-01T10:00:00.000Z',choice:'refund' as const};
  const event=prepareFullCreditNote({actor,command,source:{invoiceId:command.invoiceId,version:1,total:300000,netPaid:300000,cancelled:false},daysOpen:true,previous:null}).event;
  await db.query('INSERT INTO credit_note_prototype_operation_ids(operation_id) VALUES($1)',[command.operationId]);
  await db.query('INSERT INTO credit_note_prototype_events(operation_id,invoice_id,event) VALUES($1,$2,$3)',[command.operationId,command.invoiceId,JSON.stringify(event)]);
  await db.query("INSERT INTO credit_note_prototype_movements(operation_id,kind,balance_delta) VALUES($1,'invoice_cancellation',-300000),($1,'refund',300000)",[command.operationId]);
  assert.deepEqual(await auditStoredCreditNotes(db),{checked:1,issues:[]});
  await db.query("UPDATE credit_note_prototype_movements SET balance_delta=299000 WHERE kind='refund'");
  const bad=await auditStoredCreditNotes(db);assert.equal(bad.issues.length>0,true);assert.ok(bad.issues.some(i=>i.code==='REFUND_MOVEMENT_WRONG'));
 }finally{await db.close();}
});
