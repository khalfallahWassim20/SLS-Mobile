import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import type {PoolClient} from 'pg';
import {schemaSql} from '../../../apps/api/src/schema.js';
import {assertCreditOperationAvailable,assertInvoiceNotCredited,assertOldCreditProtocolSafe} from '../../../apps/api/src/credit-note-active-guards.js';

test('gardes serveur : base migrée, ancien schéma et migration partielle',async()=>{
 const db=new PGlite();try{
  await db.exec(schemaSql);await db.exec(schemaSql);
  const tx={query:(sql:string,params?:unknown[])=>db.query(sql,params)} as unknown as PoolClient;
  const op=randomUUID(),invoice=randomUUID();
  await assertCreditOperationAvailable(tx,op);await assertInvoiceNotCredited(tx,'sale',invoice);await assertOldCreditProtocolSafe(tx);
  await db.query('INSERT INTO credit_note_prototype_operation_ids VALUES($1)',[op]);
  await db.query("INSERT INTO credit_note_prototype_events(operation_id,invoice_id,event) VALUES($1,$2,'{}')",[op,invoice]);
  await assert.rejects(assertCreditOperationAvailable(tx,op),/déjà utilisé/);
  await assert.rejects(assertOldCreditProtocolSafe(tx),/avoirs existent/);
  await assert.rejects(assertInvoiceNotCredited(tx,'sale',invoice),/annulée/);
  await assertInvoiceNotCredited(tx,'preinvoice',invoice);
  await db.exec('DROP TABLE pre_invoice_credit_prototype_movements; DROP TABLE pre_invoice_credit_prototype_events');
  await assert.rejects(assertInvoiceNotCredited(tx,'sale',invoice),/incomplète/);await assert.rejects(assertOldCreditProtocolSafe(tx),/incomplète/);
  await db.exec('DROP TABLE credit_refund_assignment_prototype; DROP TABLE credit_note_prototype_movements; DROP TABLE credit_note_prototype_events; DROP TABLE credit_note_abandon_prototype; DROP TABLE credit_note_prototype_operation_ids');
  await assertCreditOperationAvailable(tx,op);await assertInvoiceNotCredited(tx,'sale',invoice);await assertOldCreditProtocolSafe(tx);
 }finally{await db.close();}
});
