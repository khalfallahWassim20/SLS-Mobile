import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createServer,request} from 'node:https';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readTransportConfig} from '../src/https-config.js';
import {mountHttpsAdmin} from '../src/https-admin-static.js';

test('administration statique : option désactivée et configurations dangereuses refusées',()=>{
 const root=mkdtempSync(join(tmpdir(),'sls-admin-'));try{
  mkdirSync(join(root,'assets'));writeFileSync(join(root,'index.html'),'<html></html>');
  const plain=readTransportConfig({});assert.equal(mountHttpsAdmin(express(),{},plain),false);
  assert.throws(()=>mountHttpsAdmin(express(),{SLS_ADMIN_STATIC_DIR:root},plain),/HTTPS obligatoire/);
  assert.throws(()=>mountHttpsAdmin(express(),{SLS_ADMIN_STATIC_DIR:'.',SLS_REQUIRE_HTTPS:'1'},{tls:{},addressHttps:false,expectedHost:'localhost',hsts:null}),/chemin absolu/);
  assert.throws(()=>mountHttpsAdmin(express(),{SLS_ADMIN_STATIC_DIR:root,SLS_REQUIRE_HTTPS:'1'},{tls:{},addressHttps:false,expectedHost:null,hsts:null}),/nom vérifié/);
  if(process.platform!=='win32'){
   symlinkSync(join(root,'index.html'),join(root,'assets','fuite'));
   assert.throws(()=>mountHttpsAdmin(express(),{SLS_ADMIN_STATIC_DIR:root,SLS_REQUIRE_HTTPS:'1'},{tls:{},addressHttps:false,expectedHost:'localhost',hsts:null}),/Liens symboliques/);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('administration HTTPS : fichiers limités, nom contrôlé, en-têtes et séparation API',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-admin-https-')),root=join(dir,'dist');let server:ReturnType<typeof createServer>|undefined;
 try{
  mkdirSync(join(root,'assets'),{recursive:true});writeFileSync(join(root,'index.html'),'<html>SLS admin fictif</html>');writeFileSync(join(root,'assets','app.js'),'console.log("ok");');writeFileSync(join(root,'secret.txt'),'interdit');writeFileSync(join(root,'assets','.hidden'),'secret');
  const key=join(dir,'key'),cert=join(dir,'cert');assert.equal(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'}).status,0);
  const env={SLS_REQUIRE_HTTPS:'1',SLS_TLS_KEY:key,SLS_TLS_CERT:cert,SLS_TLS_EXPECTED_HOST:'localhost',SLS_ADMIN_STATIC_DIR:root},transport=readTransportConfig(env),app=express();
  assert.equal(mountHttpsAdmin(app,env,transport),true);app.get('/api/login',(_req,res)=>res.status(401).json({error:'session'}));
  server=createServer(transport.tls!,app);const port=await new Promise<number>(resolve=>server!.listen(0,'127.0.0.1',()=>resolve((server!.address() as {port:number}).port)));
  const get=(path:string,host=`localhost:${port}`)=>new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:string}>((resolve,reject)=>{
   const req=request({hostname:'127.0.0.1',servername:'localhost',port,path,headers:{Host:host},ca:readFileSync(cert)},res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode??0,headers:res.headers,body}));});req.on('error',reject);req.end();
  });
  const page=await get('/');assert.equal(page.status,200);assert.match(page.body,/SLS admin fictif/);assert.equal(page.headers['cache-control'],'no-store');assert.equal(page.headers['x-content-type-options'],'nosniff');assert.equal(page.headers['x-frame-options'],'DENY');assert.match(String(page.headers['content-security-policy']),/frame-ancestors 'none'/);
  const asset=await get('/assets/app.js');assert.equal(asset.status,200);assert.match(asset.body,/console/);assert.equal(asset.headers['cache-control'],'no-store');
  assert.equal((await get('/','autre.example')).status,421);assert.equal((await get('/assets/app.js','autre.example')).status,421);
  assert.equal((await get('/secret.txt')).status,404);assert.equal((await get('/assets/.hidden')).status,404);assert.equal((await get('/api/login')).status,401);
 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
