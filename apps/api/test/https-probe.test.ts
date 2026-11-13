import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:tls';
import {probeHttps} from '../src/https-probe.js';

test('vérification TLS : origine stricte, autorité et nom reconnus, sans requête HTTP',{timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-probe-'));let server:ReturnType<typeof createServer>|undefined;
 try{
  const key=join(dir,'key'),cert=join(dir,'cert');
  assert.equal(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'}).status,0);
  let received=false;
  server=createServer({key:readFileSync(key),cert:readFileSync(cert)},socket=>{socket.on('data',()=>{received=true;});});
  const port=await new Promise<number>(resolve=>server!.listen(0,'127.0.0.1',()=>resolve((server!.address() as {port:number}).port)));
  const base=`https://127.0.0.1:${port}`;
  await assert.rejects(probeHttps(`http://127.0.0.1:${port}`),/origine HTTPS/);
  await assert.rejects(probeHttps(`${base}/foo`),/origine HTTPS/);
  await assert.rejects(probeHttps(base),/self-signed|certificate/i);
  await assert.rejects(probeHttps(base,readFileSync(cert)),/altname|certificate/i);
  assert.equal(received,false);
 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

test('vérification TLS réussie avec CA explicite et SAN IP : certificat présenté sans envoi de données',{timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-probe-ok-'));let server:ReturnType<typeof createServer>|undefined;
 try{
  const key=join(dir,'key'),cert=join(dir,'cert');
  assert.equal(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=test','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'}).status,0);
  let received=false;server=createServer({key:readFileSync(key),cert:readFileSync(cert)},socket=>{socket.on('data',()=>{received=true;});});
  const port=await new Promise<number>(resolve=>server!.listen(0,'127.0.0.1',()=>resolve((server!.address() as {port:number}).port)));
  const origin=`https://127.0.0.1:${port}`,result=await probeHttps(origin,readFileSync(cert));
  assert.equal(result.origin,origin);assert.match(result.protocol,/^TLSv1\.[23]$/);assert.match(result.fingerprint256,/^([A-F0-9]{2}:){31}[A-F0-9]{2}$/);assert.ok(Date.parse(result.expiresAt)>Date.now());
  const cli=async(withCa:boolean)=>new Promise<{code:number|null;output:string}>((resolvePromise,reject)=>{
   const command=spawn(process.execPath,['--import','tsx',resolve('apps/api/src/https-probe-cli.ts'),origin,...(withCa?[cert]:[])],{env:{...process.env,NODE_TLS_REJECT_UNAUTHORIZED:'0'},stdio:['ignore','pipe','pipe']});
   let output='';command.stdout!.on('data',d=>output+=d);command.stderr!.on('data',d=>output+=d);command.once('error',reject);command.once('exit',code=>resolvePromise({code,output}));
  });
  const untrusted=await cli(false);assert.notEqual(untrusted.code,0);assert.match(untrusted.output,/échouée/);
  const trusted=await cli(true);assert.equal(trusted.code,0);assert.match(trusted.output,/confiance Android/);
  assert.equal(received,false);
 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
