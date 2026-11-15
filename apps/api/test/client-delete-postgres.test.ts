import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {schemaSql} from '../src/schema.js';
import {deleteClientPermanently,ClientHasOperations} from '../src/client-delete.js';

test('suppression client : transaction, audit, opérations et concurrence',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL de test manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_delete_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:5});await pool.query(schemaSql);
  const empty=randomUUID();await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[empty,'Client vide']);
  assert.equal(await deleteClientPermanently(pool,'admin',empty),true);assert.equal(await deleteClientPermanently(pool,'admin',empty),false);
  const audit=await pool.query("SELECT actor,action,entity,entity_id,entity_name FROM audit_log WHERE entity_id=$1",[empty]);
  assert.deepEqual(audit.rows,[{actor:'admin',action:'suppression',entity:'clients',entity_id:empty,entity_name:'Client vide'}]);
  const used=randomUUID(),op=randomUUID(),sale=randomUUID();await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[used,'Client avec vente']);
  await pool.query('INSERT INTO demo_sale_events(operation_id,sale_id,version,client_id,payload,payload_hash) VALUES($1,$2,1,$3,$4::jsonb,$5)',[op,sale,used,'{}','x']);
  await assert.rejects(deleteClientPermanently(pool,'admin',used),e=>e instanceof ClientHasOperations&&e.usage.some(u=>u.label==='vente(s)'&&u.count===1));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM clients WHERE id=$1',[used])).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_id=$1 AND action='suppression'",[used])).rows[0].n,0);
  const linked=randomUUID();await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[linked,'Client référencé']);await pool.query('CREATE TABLE future_reference(client_id uuid REFERENCES clients(id))');await pool.query('INSERT INTO future_reference VALUES($1)',[linked]);
  await assert.rejects(deleteClientPermanently(pool,'admin',linked),e=>(e as {code?:string}).code==='23503');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM clients WHERE id=$1',[linked])).rows[0].n,1);
  const racing=randomUUID();await pool.query('INSERT INTO clients(id,name) VALUES($1,$2)',[racing,'Client concurrent']);
  const writer=await pool.connect();try{
   await writer.query('BEGIN');await writer.query('SELECT id FROM clients WHERE id=$1 FOR SHARE',[racing]);
   const deletion=deleteClientPermanently(pool,'admin',racing).then(value=>({value,error:null}),error=>({value:null,error}));
   assert.equal(await Promise.race([deletion.then(()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),150))]),false);
   await writer.query('INSERT INTO demo_settlements(operation_id,client_id,payload,payload_hash) VALUES($1,$2,$3::jsonb,$4)',[randomUUID(),racing,'{}','x']);await writer.query('COMMIT');
   const outcome=await deletion;assert.ok(outcome.error instanceof ClientHasOperations);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM clients WHERE id=$1',[racing])).rows[0].n,1);
  }finally{await writer.query('ROLLBACK');writer.release();}
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
