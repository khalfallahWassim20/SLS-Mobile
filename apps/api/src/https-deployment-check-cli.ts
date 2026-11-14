import {readFileSync} from 'node:fs';
import {checkHttpsDeployment} from './https-deployment-check.js';

async function main(){
 const [origin,caFile,...extra]=process.argv.slice(2);
 if(!origin||extra.length)throw Error('Usage : npm run verifier:deploiement-https -- https://nom:port [fichier-autorite-publique.pem]');
 const result=await checkHttpsDeployment(origin,caFile?readFileSync(caFile):undefined);
 console.log('Diagnostic HTTPS sans identifiants :',JSON.stringify(result,null,2));
 console.log('Ce contrôle ne prouve ni la confiance Android, ni l’identité de la base, ni les opérations hors ligne.');
}
main().catch(error=>{console.error('Diagnostic HTTPS échoué :',error instanceof Error?error.message:'erreur inconnue');process.exitCode=1;});
