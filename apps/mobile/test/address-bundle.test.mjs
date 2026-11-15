/** Contrat du bundle Android : le bouton de rapprochement doit être livré
 * même sans variable EXPO_PUBLIC. La route serveur reste désactivée par défaut. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const mobile=resolve(fileURLToPath(new URL('..',import.meta.url)));

test('bundle Android normal : bouton présent sans variable Expo publique', {timeout:120000},()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-mobile-address-'));
 try{
  const env={...process.env};delete env.EXPO_PUBLIC_SLS_ADDRESS_PRIVATE_HTTP;delete env.EXPO_PUBLIC_SLS_V5_TEST_ONLY;delete env.EXPO_PUBLIC_SLS_V5_BRIDGE_TEST_ONLY;delete env.EXPO_PUBLIC_SLS_ADDRESS_TEST_ONLY;
  const executable=process.execPath,cli=resolve(mobile,'../../node_modules/expo/bin/cli');
  const run=spawnSync(executable,[cli,'export','--platform','android','--no-bytecode','--no-minify','--clear','--output-dir',dir],{cwd:mobile,env,encoding:'utf8',timeout:110000});
  assert.equal(run.status,0,`Échec export Android : ${run.stderr}\n${run.stdout}`);
  const folder=join(dir,'_expo','static','js','android'),files=readdirSync(folder).filter(x=>x.endsWith('.js'));assert.equal(files.length,1);
  const source=readFileSync(join(folder,files[0]),'utf8');
  assert.match(source,/var V5_TEST_ONLY = false/);
  assert.match(source,/var V5_BRIDGE_TEST_ONLY = false/);
  assert.ok(source.includes('creditBridgeAvailable'));
  assert.ok(source.includes('Passer aux avoirs'));
  assert.ok(source.includes('v5ServerAvailable'));
  // Le nouveau design doit rester raccordé aux fonctions réelles, sans perdre
  // la synchronisation ou l'écran des dépenses du bundle normal.
  assert.ok(source.includes('JournalHome'));
  assert.ok(source.includes('JournalDrawer'));
  assert.ok(source.includes('uploadTourExpenses'));
  assert.ok(source.includes('uploadDemoQueue'));
  assert.ok(source.includes('Dépenses de tournée') || source.includes('D\\u00E9penses de tourn\\u00E9e'));
  assert.ok(source.includes('refreshReferenceFromHeader'));
  assert.match(source,/label: "Changer l\\u2019adresse du serveur"/);
  assert.doesNotMatch(source,/var ADDRESS_PRIVATE_HTTP = false/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
