import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {verifyBackup} from '../verifier-sauvegarde.mjs';

test('vérification en lecture seule : empreinte et contrôle catalogue, erreurs bloquantes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sls-backup-'));
 try {
  const file=join(dir,'test.dump'),data=Buffer.from('PGDMP fake data');await writeFile(file,data);
  const fake=(code,check=true)=>(cmd,args,opts)=>{
   assert.equal(cmd,'docker');assert.deepEqual(args,['exec','-i','postgres-test','pg_restore','--list']);
   return spawn(process.execPath,['-e',`let b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>process.exit(Number(${code} || (${check}?Buffer.concat(b).toString()!==${JSON.stringify(data.toString())}:false))));`],opts);
  };
  const result=await verifyBackup(file,'postgres-test',{spawn:fake(0)});
  assert.equal(result.sha256,createHash('sha256').update(data).digest('hex'));assert.equal(result.size,String(data.length));
  await assert.rejects(verifyBackup(file,'postgres-test',{spawn:fake(1)}),/catalogue impossible/);
  await assert.rejects(verifyBackup(file,'postgres-test',{spawn:(_cmd,_args,opts)=>spawn(process.execPath,['-e',`process.stdin.resume();process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(file)},'x');});`],opts)}),/a changé/);
  await writeFile(file,data);
  await assert.rejects(verifyBackup(file,'postgres-test',{spawn:(_cmd,_args,opts)=>spawn(process.execPath,['-e','setInterval(()=>{},1000)'],opts),timeoutMs:100}),/catalogue impossible/);
  await assert.rejects(verifyBackup(file,'postgres-test',{spawn:(_cmd,_args,opts)=>spawn(join(dir,'inexistant'),[],opts)}),/ENOENT/);
  await assert.rejects(verifyBackup(file,'--privileged',{spawn:fake(0)}),/conteneur/);
  await writeFile(file,'not a dump');await assert.rejects(verifyBackup(file,'postgres-test',{spawn:fake(0)}),/Format non reconnu/);
  await assert.rejects(verifyBackup(join(dir,'absent'),'postgres-test'),/ENOENT/);
 } finally {await rm(dir,{recursive:true,force:true});}
});
