import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';

// Lecture seule : pg_restore --list lit l'archive sur stdin, sans connexion à PostgreSQL.
export async function verifyBackup(file, container, options = {}) {
 if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container)) throw Error('Nom de conteneur Docker invalide.');
 const handle = await open(file, 'r');
 try {
  const before = await handle.stat({bigint:true});
  if (!before.isFile() || before.size < 5n) throw Error('Archive absente, vide ou non régulière.');
  const header = Buffer.alloc(5);
  const read = await handle.read(header, 0, 5, 0);
  if (read.bytesRead !== 5 || header.toString('ascii') !== 'PGDMP') throw Error('Format non reconnu : archive PostgreSQL personnalisée attendue.');
  const hash = createHash('sha256');
  await pipeline(handle.createReadStream({autoClose:false, start:0}), hash);
  const digest = hash.digest('hex');
  const child = (options.spawn ?? spawn)('docker', ['exec','-i',container,'pg_restore','--list'], {stdio:['pipe','ignore','pipe'], windowsHide:true});
  // Ne pas afficher le catalogue ni les messages susceptibles de contenir des données privées.
  child.stderr.resume();
  let timedOut = false;
  const timeout = setTimeout(() => {timedOut = true;child.stdin.destroy();child.kill('SIGKILL');}, options.timeoutMs ?? 120000);
  const exited = new Promise((resolve,reject) => {child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  // Gérer une fermeture anticipée de stdin tout en attendant le code du processus.
  const sent = pipeline(handle.createReadStream({autoClose:false,start:0}),child.stdin).then(()=>null,error=>error);
  let result, sendError;
  try { [result,sendError] = await Promise.all([exited,sent]); } finally { clearTimeout(timeout); }
  // --list peut fermer stdin après lecture du catalogue, avant la fin des données.
  if (timedOut || result.code !== 0 || (sendError && sendError.code !== 'EPIPE')) throw Error(`Lecture du catalogue impossible (code ${result.code ?? 'interrompu'}). Vérifier Docker, le conteneur et l'archive.`);
  const after = await handle.stat({bigint:true});
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw Error('Le fichier a changé pendant la vérification.');
  return {size:before.size.toString(),sha256:digest};
 } finally { await handle.close(); }
}

async function main() {
 const [container,file,...extra] = process.argv.slice(2);
 if (!container || !file || extra.length) throw Error('Usage : node scripts/verifier-sauvegarde.mjs NOM_CONTENEUR CHEMIN_DUMP');
 const result = await verifyBackup(file,container);
 console.log(`Catalogue lisible ; taille : ${result.size} octets ; SHA-256 : ${result.sha256}`);
 console.log('Ce contrôle ne prouve ni une restauration complète, ni l’identité de la base. Les opérations hors ligne ne sont pas incluses.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error=>{console.error('Vérification échouée :',error.message);process.exitCode=1;});
