/** Test isolé : aucune donnée de la base principale n'est utilisée. */
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {runExistingDeviceBridgeScenario,type BridgeDatabase} from '../../../packages/domain/test/credit-existing-device-bridge-scenario.js';

test('PostgreSQL réel : ancien téléphone, deux avoirs et reprise après réponse perdue',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_old_device_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});
  const db={exec:(sql:string)=>pool!.query(sql),query:(sql:string,args?:unknown[])=>pool!.query(sql,args)} as BridgeDatabase;
  await runExistingDeviceBridgeScenario(db,pool);
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
