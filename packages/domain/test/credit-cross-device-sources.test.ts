import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {runCreditCrossDeviceScenario,type CreditScenarioDatabase} from './credit-cross-device-scenario.js';

test('deuxième appareil : avoirs distants sans copier les factures dans les tables actives',async()=>{
 const db=new PGlite();
 const conn={query:(sql:string,args?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,args),release:()=>{}};
 const pool={connect:async()=>conn,query:conn.query} as unknown as Pool;
 try{await runCreditCrossDeviceScenario(db as CreditScenarioDatabase,pool);}finally{await db.close();}
});
