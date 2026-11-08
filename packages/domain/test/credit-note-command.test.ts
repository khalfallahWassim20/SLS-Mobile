import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareFullCreditNote,type CreditNoteActor,type CreditNoteCommand} from '../src/credit-note-command.js';
const actor:CreditNoteActor={id:'a1000000-0000-4000-8000-000000000001',role:'commercial'};
const cmd:CreditNoteCommand={operationId:'a1000000-0000-4000-8000-000000000002',invoiceId:'a1000000-0000-4000-8000-000000000003',expectedVersion:3,recordedAt:'2026-11-08T10:00:00.000Z',choice:'credit'};
const source={invoiceId:cmd.invoiceId,version:3,total:600000,netPaid:200000,cancelled:false};
test('avoir : trace la facture, le choix, le crédit et le delta à partir de la version verrouillée',()=>{
 const result=prepareFullCreditNote({actor,command:cmd,source,daysOpen:true,previous:null});
 assert.equal(result.status,'received');assert.equal(result.event.resultVersion,4);assert.equal(result.event.noteTotal,600000);assert.equal(result.event.retainedCredit,200000);assert.equal(result.event.refund,0);assert.equal(result.event.balanceDelta,-600000);assert.deepEqual(result.event.source,source);
 const refunded=prepareFullCreditNote({actor,command:{...cmd,choice:'refund'},source,daysOpen:true,previous:null});assert.equal(refunded.event.refund,200000);assert.equal(refunded.event.retainedCredit,0);assert.equal(refunded.event.balanceDelta,-400000);
});
test('renvoi identique : accusé original même après clôture ou changement de version',()=>{
 const event=prepareFullCreditNote({actor,command:cmd,source,daysOpen:true,previous:null}).event;
 const retry=prepareFullCreditNote({actor,command:{...cmd},source:{...source,version:4,cancelled:true},daysOpen:false,previous:event});
 assert.equal(retry.status,'duplicate');assert.deepEqual(retry.event,event);
 assert.throws(()=>prepareFullCreditNote({actor,command:{...cmd,choice:'refund'},source,daysOpen:true,previous:event}),/déjà utilisé/);
 assert.throws(()=>prepareFullCreditNote({actor:{id:'admin',role:'admin'},command:cmd,source,daysOpen:true,previous:event}),/déjà utilisé/);
});
test('refuse journée fermée, version périmée, deuxième avoir et acteur invalide',()=>{
 const input={actor,command:cmd,source,daysOpen:true,previous:null};
 assert.throws(()=>prepareFullCreditNote({...input,daysOpen:false}),/clôturée/);
 assert.throws(()=>prepareFullCreditNote({...input,source:{...source,version:4}}),/Version/);
 assert.throws(()=>prepareFullCreditNote({...input,source:{...source,cancelled:true}}),/déjà annulée/);
 assert.throws(()=>prepareFullCreditNote({...input,actor:{...actor,id:'autre'}}),/Acteur/);
 assert.throws(()=>prepareFullCreditNote({...input,command:{...cmd,recordedAt:'2026-02-30T10:00:00.000Z'}}),/invalide/);
 assert.throws(()=>prepareFullCreditNote({...input,command:{...cmd,operationId:'mauvais'}}),/invalide/);
});
