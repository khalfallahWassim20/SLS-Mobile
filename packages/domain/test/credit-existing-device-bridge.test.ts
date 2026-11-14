import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {runExistingDeviceBridgeScenario,type BridgeDatabase} from './credit-existing-device-bridge-scenario.js';
test('ancien téléphone : liaison v4, deux avoirs hors ligne puis synchronisation HTTP idempotente',async()=>{
 const db=new PGlite(),conn={query:(sql:string,args?:unknown[])=>sql.startsWith('SELECT pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,args),release:()=>{}};
 const pool={query:conn.query,connect:async()=>conn} as unknown as Pool;
 try{await runExistingDeviceBridgeScenario(db as BridgeDatabase,pool);}finally{await db.close();}
});
