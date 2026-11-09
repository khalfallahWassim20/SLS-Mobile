/** Parcours SQLite–HTTP sur PostgreSQL réel, uniquement dans un schéma de test. */
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {runCreditCrossDeviceScenario,type CreditScenarioDatabase} from '../../../packages/domain/test/credit-cross-device-scenario.js';
test('PostgreSQL réel : deux appareils, avoirs, reprise, conflit, clôture et réouverture',async()=>{
 const url=process.env.DATABASE_URL;if(!url)throw Error('DATABASE_URL manquante');
 const root=new pg.Pool({connectionString:url}),schema='sls_credit_devices_'+randomUUID().replaceAll('-','');let pool:pg.Pool|undefined,created=false;
 try{
  await root.query(`CREATE SCHEMA "${schema}"`);created=true;pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:10});
  const db={exec:(sql:string)=>pool!.query(sql),query:(sql:string,args?:unknown[])=>pool!.query(sql,args)} as CreditScenarioDatabase;
  await runCreditCrossDeviceScenario(db,pool);
 }finally{if(pool)await pool.end();if(created)await root.query(`DROP SCHEMA "${schema}" CASCADE`);await root.end();}
});
