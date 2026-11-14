import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:https';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {checkHttpsDeployment} from '../src/https-deployment-check.js';

test('diagnostic HTTPS : sans secrets, sans redirection, contrôle authentification et interface',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-deployment-check-'));let server:ReturnType<typeof createServer>|undefined;
 try{
  const key=join(dir,'key'),cert=join(dir,'cert');
  assert.equal(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=test','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'}).status,0);
  let mode='ok';const requests:{path:string;authorization:unknown;cookie:unknown}[]=[];
  server=createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
   requests.push({path:req.url??'',authorization:req.headers.authorization,cookie:req.headers.cookie});
   if(mode==='redirect'){res.writeHead(302,{Location:'https://example.invalid/secret'});res.end();return;}
   if(mode==='oversized'){res.writeHead(401,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end('a'.repeat(70000));return;}
   res.setHeader('Cache-Control',mode==='cache'?'public':'no-store');res.setHeader('X-Content-Type-Options','nosniff');
   if(req.url==='/api/mobile/session'){res.writeHead(mode==='unprotected'?200:401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Session invalide ou expirée.'}));return;}
   if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Frame-Options':'DENY','Content-Security-Policy':mode==='bad-csp'?"object-src 'none'":"frame-ancestors 'none'; object-src 'none'"});res.end('<!doctype html><div id="root"></div>');return;}
   res.writeHead(404);res.end();
  });
  const port=await new Promise<number>(resolve=>server!.listen(0,'127.0.0.1',()=>resolve((server!.address() as {port:number}).port))),origin=`https://127.0.0.1:${port}`,ca=readFileSync(cert);
  await assert.rejects(checkHttpsDeployment(origin),/self-signed|certificate/i);
  const value=await checkHttpsDeployment(origin,ca);assert.equal(value.origin,origin);assert.equal(value.api,'refus sans session vérifié');assert.equal(value.admin,'interface et en-têtes reçus');assert.match(value.fingerprint256,/^([A-F0-9]{2}:){31}[A-F0-9]{2}$/);
  assert.deepEqual(requests.map(x=>x.path),['/api/mobile/session','/']);assert.ok(requests.every(x=>x.authorization===undefined&&x.cookie===undefined));
  mode='unprotected';await assert.rejects(checkHttpsDeployment(origin,ca),/API : réponse inattendue/);
  mode='redirect';const before=requests.length;await assert.rejects(checkHttpsDeployment(origin,ca),/redirection/);assert.equal(requests.length,before+1);
  mode='cache';await assert.rejects(checkHttpsDeployment(origin,ca),/en-têtes/);
  mode='bad-csp';await assert.rejects(checkHttpsDeployment(origin,ca),/Administration/);
  mode='oversized';await assert.rejects(checkHttpsDeployment(origin,ca),/volumineuse/);
  mode='ok';await assert.rejects(checkHttpsDeployment(origin+'/path',ca),/origine HTTPS/);
  const run=async(withCa:boolean)=>new Promise<{code:number|null;out:string}>((resolvePromise,reject)=>{
   const child=spawn(process.execPath,['--import','tsx',resolve('apps/api/src/https-deployment-check-cli.ts'),origin,...(withCa?[cert]:[])],{env:{...process.env,NODE_TLS_REJECT_UNAUTHORIZED:'0'},stdio:['ignore','pipe','pipe']});let out='';child.stdout!.on('data',x=>out+=x);child.stderr!.on('data',x=>out+=x);child.once('error',reject);child.once('exit',code=>resolvePromise({code,out}));
  });
  const bad=await run(false);assert.notEqual(bad.code,0);assert.match(bad.out,/échoué/);
  const good=await run(true);assert.equal(good.code,0);assert.match(good.out,/identité de la base/);
 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
