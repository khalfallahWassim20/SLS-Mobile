/** Proxy Vite réel et API HTTPS fictive ; aucun accès à la base. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer as httpsServer} from 'node:https';
import {createServer as netServer} from 'node:net';

async function freePort(){return new Promise<number>((resolve,reject)=>{const s=netServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string')return reject(Error('port'));s.close(()=>resolve(a.port));});});}
test('proxy admin Vite : refuse une autorité inconnue ou un nom incorrect',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-vite-tls-'));let child:ChildProcess|undefined,server:ReturnType<typeof httpsServer>|undefined;
 try{
  const key=join(dir,'key'),cert=join(dir,'cert');
  assert.equal(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=test','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'}).status,0);
  let caFile=cert,calls=0;server=httpsServer({key:readFileSync(key),cert:readFileSync(cert)},(_req,res)=>{calls++;res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');});
  const backend=await new Promise<number>(resolve=>server!.listen(0,'127.0.0.1',()=>resolve((server!.address() as {port:number}).port)));
  async function run(ca:boolean,host:string){
   const port=await freePort(),env={...process.env,SLS_ADMIN_API_PROXY:`https://${host}:${backend}`};delete env.NODE_TLS_REJECT_UNAUTHORIZED;delete env.NODE_EXTRA_CA_CERTS;if(ca)env.NODE_EXTRA_CA_CERTS=caFile;
   child=spawn(process.execPath,[resolve('node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:resolve('apps/admin'),env,stdio:['ignore','pipe','pipe']});
   await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Vite non démarré')),12000);child!.stdout!.on('data',d=>{if(String(d).includes('Local:')){clearTimeout(timer);resolve();}});child!.once('exit',c=>{clearTimeout(timer);reject(Error(`Vite arrêté ${c}`));});});
   try{const response=await fetch(`http://127.0.0.1:${port}/api/probe`,{signal:AbortSignal.timeout(5000)});return response.status;}
   finally{await new Promise<void>(resolve=>{child!.once('exit',()=>resolve());child!.kill('SIGTERM');});child=undefined;}
  }
  assert.equal(await run(false,'127.0.0.1'),500);assert.equal(calls,0);
  assert.equal(await run(true,'127.0.0.1'),200);assert.equal(calls,1);
  await new Promise<void>(resolve=>server!.close(()=>resolve()));
  const key2=join(dir,'key2'),cert2=join(dir,'cert2');
  assert.equal(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key2,'-out',cert2,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'}).status,0);
  caFile=cert2;server=httpsServer({key:readFileSync(key2),cert:readFileSync(cert2)},(_req,res)=>{calls++;res.end('unexpected');});
  await new Promise<void>(resolve=>server!.listen(backend,'127.0.0.1',resolve));
  assert.equal(await run(true,'127.0.0.1'),500);assert.equal(calls,1);
 }finally{if(child&&child.exitCode===null)await new Promise<void>(resolve=>{child!.once('exit',()=>resolve());child!.kill('SIGTERM');});if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
