/** Bundle fictif seulement : n'active aucun serveur ni base. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const mobile=resolve(fileURLToPath(new URL('..',import.meta.url)));
test('bundle Android fictif : pont v4 vers avoirs explicitement activé, mode v5 direct désactivé',{timeout:120000},()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-mobile-bridge-'));
 try{
  const env={...process.env,EXPO_PUBLIC_SLS_V5_BRIDGE_TEST_ONLY:'DONNEES_FICTIVES_ISOLEES'};delete env.EXPO_PUBLIC_SLS_V5_TEST_ONLY;delete env.EXPO_PUBLIC_SLS_ADDRESS_TEST_ONLY;
  const cli=resolve(mobile,'../../node_modules/expo/bin/cli');
  const run=spawnSync(process.execPath,[cli,'export','--platform','android','--no-bytecode','--no-minify','--clear','--output-dir',dir],{cwd:mobile,env,encoding:'utf8',timeout:110000});
  assert.equal(run.status,0,`Export Android : ${run.stderr}\n${run.stdout}`);
  const folder=join(dir,'_expo','static','js','android'),files=readdirSync(folder).filter(x=>x.endsWith('.js'));assert.equal(files.length,1);
  const source=readFileSync(join(folder,files[0]),'utf8');
  assert.match(source,/var V5_TEST_ONLY = false/);assert.match(source,/var V5_BRIDGE_TEST_ONLY = true/);
  assert.ok(source.includes("Passer aux avoirs"));assert.ok(source.includes("passage aux avoirs en cours"));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
