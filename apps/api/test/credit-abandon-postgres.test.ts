/** Envoi et abandon d'un avoir : un seul résultat possible sous concurrence. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {saveCommercial,setCommercialCredentials} from '../src/commercials.js';
import {loginCommercial} from '../src/commercial-session.js';
import {storeIdentifiedSale} from '../src/identified-operations.js';
import {storeJournalSnapshot} from '../src/journal-store.js';
import {storePrototypeCreditNote} from '../src/credit-note-registry-prototype.js';
import {storePrototypePreInvoiceCredit} from '../src/pre-invoice-credit-registry-prototype.js';
import {abandonCreditNotePrototype} from '../src/credit-note-abandon-prototype.js';
import {readPrototypeCreditReference} from '../src/credit-note-reference-prototype.js';

test('PostgreSQL : course entre abandon et envoi d’avoirs vente et préétablie',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_credit_abandon_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});await pool.query(schemaSql);await pool.query("UPDATE tour_sync_mode SET mode='identified' WHERE id=1");
  const secret='secret fictif assez long pour les tests',commercial=await saveCommercial(pool,'admin',{name:'Commercial fictif',active:true});await setCommercialCredentials(pool,'admin',commercial.id,{login:'credit.abandon',password:'mot de passe fictif'});
  const session=await loginCommercial(pool,secret,{login:'credit.abandon',password:'mot de passe fictif'});assert.ok(session);const auth={secret,token:session.token,creditAware:true},principal={kind:'commercial' as const,secret,token:session.token};
  for(const kind of ['sale','preinvoice'] as const)for(let i=0;i<5;i++){
   const clientId=randomUUID(),invoiceId=randomUUID(),at='2026-11-07T09:00:00.000Z';await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[clientId,'Client fictif']);
   if(kind==='sale'){
    const sale={createdAt:at,clientId,clientName:'Client fictif',syncSaleId:invoiceId,syncVersion:1,lines:[{name:'Huile',code:'X',quantity:1,unitPrice:100000,discount:0,vat:1900}],total:119000,paid:0,remaining:119000,paymentMode:'Crédit',chequeNumber:'',chequeBank:'',chequeDue:''};
    await storeIdentifiedSale(pool,{operationId:randomUUID(),saleId:invoiceId,version:1,recordedAt:at,sale,refund:0},auth);
   }else{
    const invoice={id:invoiceId,clientId,clientName:'Client fictif',journalDate:'2026-11-07',createdAt:at,sector:'',amount:600000};
    await storeJournalSnapshot(pool,{operationId:randomUUID(),version:1,invoice,receipts:[]},'identified',auth);
   }
   const command={operationId:randomUUID(),invoiceId,expectedVersion:1,recordedAt:'2026-11-07T10:00:00.000Z',choice:null};
   const send=()=>kind==='sale'?storePrototypeCreditNote(pool!,command,principal):storePrototypePreInvoiceCredit(pool!,command,principal);
   const abandon=()=>abandonCreditNotePrototype(pool!,{kind,command},auth);
   const results=await Promise.allSettled(i%2?[send(),abandon()]:[abandon(),send()]);const written=results[i%2?0:1],reserved=results[i%2?1:0];
   assert.equal(reserved.status,'fulfilled');if(reserved.status!=='fulfilled')throw reserved.reason;
   if(reserved.value.status==='already-received')assert.equal(written.status,'fulfilled');else assert.equal(written.status,'rejected');
   const counts=await pool.query(`SELECT (SELECT count(*)::int FROM credit_note_prototype_events WHERE operation_id=$1)+(SELECT count(*)::int FROM pre_invoice_credit_prototype_events WHERE operation_id=$1) AS sent,(SELECT count(*)::int FROM credit_note_abandon_prototype WHERE operation_id=$1) AS abandoned`,[command.operationId]);
   assert.equal(counts.rows[0].sent+counts.rows[0].abandoned,1);assert.equal((await abandon()).status,reserved.value.status);assert.equal((await readPrototypeCreditReference(pool)).version,5);
  }
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
