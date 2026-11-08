/** Cette commande est destructive ; ne jamais l'exécuter sur des données réelles. */
import dotenv from 'dotenv';
dotenv.config({path:'apps/api/.env'});
import pg from 'pg';
import {resetTestOperations} from './reset-test-operations.js';
if(process.argv.length!==3 || process.argv[2]!=='EFFACER_LES_OPERATIONS_FICTIVES') {
 console.error('Refus : après arrêt de l’API et déconnexion de tous les téléphones, utilisez npm run reset:test-operations -- EFFACER_LES_OPERATIONS_FICTIVES');
 process.exit(1);
}
if(!process.env.DATABASE_URL) {console.error('DATABASE_URL manquante dans apps/api/.env.');process.exit(1);}
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
try {await resetTestOperations(pool);console.log('Opérations fictives serveur supprimées. Clients, articles, comptes, soldes initiaux et mode conservés.');}
finally {await pool.end();}
