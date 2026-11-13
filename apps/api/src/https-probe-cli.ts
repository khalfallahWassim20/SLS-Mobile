import {readFileSync} from 'node:fs';
import {probeHttps} from './https-probe.js';

async function main(){
 const [origin,caFile,...extra]=process.argv.slice(2);
 if(!origin||extra.length)throw Error('Usage : npm run verifier:https -- https://nom:port [fichier-autorite-publique.pem]');
 const result=await probeHttps(origin,caFile?readFileSync(caFile):undefined);
 console.log('TLS vérifié depuis Node :',JSON.stringify(result,null,2));
 console.log('Ce contrôle ne vérifie ni la confiance Android ni l’identité de la base.');
}
main().catch(error=>{console.error('Vérification HTTPS échouée :',error instanceof Error?error.message:'erreur inconnue');process.exitCode=1;});
