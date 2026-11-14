import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,copyFile,link,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {compareBackups} from '../comparer-sauvegardes.mjs';

test('comparaison en lecture seule de copies, fichiers identiques et divergences',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sls-copy-'));
 try{
  const a=join(dir,'original.dump'),b=join(dir,'copie.dump'),hard=join(dir,'lien.dump');
  const data=Buffer.from('archive fictive PGDMP');await writeFile(a,data);await copyFile(a,b);
  assert.deepEqual(await compareBackups(a,b),{size:String(data.length),sha256:createHash('sha256').update(data).digest('hex')});
  assert.equal(spawnSync(process.execPath,['scripts/comparer-sauvegardes.mjs',a,b]).status,0);
  await assert.rejects(compareBackups(a,a),/distincts/);
  await link(a,hard);await assert.rejects(compareBackups(a,hard),/même fichier/);
  await writeFile(b,Buffer.from('archive fictive PGDMQ'));await assert.rejects(compareBackups(a,b),/différente/);
  assert.notEqual(spawnSync(process.execPath,['scripts/comparer-sauvegardes.mjs',a,b]).status,0);
  await writeFile(b,'');await assert.rejects(compareBackups(a,b),/non vides/);
  await assert.rejects(compareBackups(a,dir),/réguliers/);
  await assert.rejects(compareBackups(a,join(dir,'absent')),/ENOENT/);
  if(process.platform!=='win32'){const sym=join(dir,'sym');await symlink(a,sym);await assert.rejects(compareBackups(a,sym),/distincts/);}
 }finally{await rm(dir,{recursive:true,force:true});}
});
