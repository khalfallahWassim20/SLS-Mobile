/** TLS local jetable : aucun accès à une base ni certificat réel. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer as netServer,connect} from 'node:net';
import {request} from 'node:https';
import {readTransportConfig} from '../src/https-config.js';
import {checkHttpsDeployment} from '../src/https-deployment-check.js';
import bcrypt from 'bcryptjs';

function makeCertificate(dir:string,name:string){
 const key=join(dir,`${name}.key`),cert=join(dir,`${name}.pem`);
 const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
 assert.equal(generated.status,0,'openssl requis');return {key,cert};
}
test('configuration TLS explicite : refuse omissions, mélanges et clé incorrecte',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-tls-config-'));try{
  const first=makeCertificate(dir,'first'),second=makeCertificate(dir,'second');
  assert.equal(readTransportConfig({}).tls,null);assert.equal(readTransportConfig({}).hsts,null);
  assert.throws(()=>readTransportConfig({SLS_REQUIRE_HTTPS:'1'}),/clé et un certificat/);
  assert.throws(()=>readTransportConfig({SLS_REQUIRE_HTTPS:'0'}),/doit valoir/);
  assert.throws(()=>readTransportConfig({SLS_REQUIRE_HTTPS:'1',SLS_ADDRESS_PRIVATE_HTTP:'J_ACCEPTE_LES_RISQUES_HTTP'}),/incompatible/);
  assert.throws(()=>readTransportConfig({SLS_REQUIRE_HTTPS:'1',SLS_ADDRESS_TEST_ONLY:'DONNEES_FICTIVES_ISOLEES',SLS_V5_TEST_ONLY:'DONNEES_FICTIVES_ISOLEES',SLS_ADDRESS_TEST_TLS_KEY:first.key,SLS_ADDRESS_TEST_TLS_CERT:first.cert}),/incompatible/);
  assert.throws(()=>readTransportConfig({SLS_ADDRESS_HTTPS:'J_ACTIVE_HTTPS'}),/clé et un certificat/);
  assert.throws(()=>readTransportConfig({SLS_TLS_KEY:first.key}),/clé et un certificat/);
  assert.throws(()=>readTransportConfig({SLS_TLS_KEY:second.key,SLS_TLS_CERT:first.cert}),/correspond pas/);
  assert.throws(()=>readTransportConfig({SLS_TLS_KEY:first.key,SLS_TLS_CERT:first.cert,SLS_ADDRESS_PRIVATE_HTTP:'J_ACCEPTE_LES_RISQUES_HTTP'}),/HTTP privé/);
  assert.throws(()=>readTransportConfig({SLS_ADDRESS_TEST_TLS_KEY:first.key}),/paramètres TLS de test/);
  assert.throws(()=>readTransportConfig({SLS_ADDRESS_TEST_ONLY:'DONNEES_FICTIVES_ISOLEES',SLS_V5_TEST_ONLY:'DONNEES_FICTIVES_ISOLEES',SLS_ADDRESS_TEST_TLS_KEY:first.key,SLS_ADDRESS_TEST_TLS_CERT:first.cert,SLS_TLS_KEY:second.key}),/mélanger/);
  const secure={SLS_REQUIRE_HTTPS:'1',SLS_TLS_KEY:first.key,SLS_TLS_CERT:first.cert};
  assert.throws(()=>readTransportConfig(secure),/SLS_TLS_EXPECTED_HOST/);
  assert.throws(()=>readTransportConfig({...secure,SLS_TLS_EXPECTED_HOST:'https://localhost:3001'}),/Nom TLS attendu invalide/);
  assert.throws(()=>readTransportConfig({...secure,SLS_TLS_EXPECTED_HOST:'localhost:3001'}),/Nom TLS attendu invalide/);
  assert.throws(()=>readTransportConfig({...secure,SLS_TLS_EXPECTED_HOST:'autre.example'}),/ne couvre pas/);
  assert.throws(()=>readTransportConfig({...secure,SLS_TLS_EXPECTED_HOST:'127.0.0.2'}),/ne couvre pas/);
  assert.throws(()=>readTransportConfig({SLS_TLS_EXPECTED_HOST:'localhost'}),/exige une configuration TLS/);
  assert.equal(readTransportConfig({...secure,SLS_TLS_EXPECTED_HOST:'127.0.0.1'}).tls?.minVersion,'TLSv1.2');
  assert.throws(()=>readTransportConfig({SLS_HSTS_MAX_AGE:'300'}),/HSTS exige HTTPS/);
  assert.throws(()=>readTransportConfig({...secure,SLS_TLS_EXPECTED_HOST:'127.0.0.1',SLS_HSTS_MAX_AGE:'300'}),/nom DNS/);
  for(const invalid of ['-1','1.5','01','31536001','1; includeSubDomains',''])assert.throws(()=>readTransportConfig({...secure,SLS_TLS_EXPECTED_HOST:'localhost',SLS_HSTS_MAX_AGE:invalid}),/Durée HSTS invalide/);
  assert.deepEqual(readTransportConfig({...secure,SLS_TLS_EXPECTED_HOST:'localhost',SLS_HSTS_MAX_AGE:'300'}).hsts,{host:'localhost',maxAge:300});
  assert.deepEqual(readTransportConfig({...secure,SLS_TLS_EXPECTED_HOST:'localhost',SLS_HSTS_MAX_AGE:'0'}).hsts,{host:'localhost',maxAge:0});
  const config=readTransportConfig({...secure,SLS_TLS_EXPECTED_HOST:'LOCALHOST',SLS_ADDRESS_HTTPS:'J_ACTIVE_HTTPS'});
  assert.equal(config.addressHttps,true);assert.equal(config.tls?.minVersion,'TLSv1.2');assert.equal(config.hsts,null);
  const noSanKey=join(dir,'nosan.key'),noSanCert=join(dir,'nosan.pem');
  assert.equal(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',noSanKey,'-out',noSanCert,'-days','1','-subj','/CN=localhost'],{stdio:'ignore'}).status,0);
  assert.throws(()=>readTransportConfig({SLS_REQUIRE_HTTPS:'1',SLS_TLS_KEY:noSanKey,SLS_TLS_CERT:noSanCert,SLS_TLS_EXPECTED_HOST:'localhost'}),/ne couvre pas/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('HTTPS obligatoire sans certificat : le serveur refuse de démarrer',{timeout:30000},()=>{
 const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('SLS_')||k==='NODE_TLS_REJECT_UNAUTHORIZED'||k==='NODE_EXTRA_CA_CERTS')delete env[k];
 Object.assign(env,{DATABASE_URL:'postgresql://invalid:invalid@127.0.0.1:1/isolated',PORT:'0',API_HOST:'127.0.0.1',JWT_SECRET:'secret de test suffisamment long pour le serveur',ADMIN_USERNAME:'test',ADMIN_PASSWORD_HASH:bcrypt.hashSync('fictif',4),SLS_REQUIRE_HTTPS:'1'});
 const result=spawnSync(process.execPath,['--import','tsx','src/server.ts'],{cwd:resolve('apps/api'),env,encoding:'utf8',timeout:15000});
 assert.notEqual(result.status,0);assert.equal(result.signal,null);assert.match(result.stderr,/clé et un certificat TLS/);assert.doesNotMatch(result.stdout,/API de développement prête/);
});

test('HTTPS obligatoire : un nom différent du certificat empêche le démarrage',{timeout:30000},()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-tls-wrong-name-'));try{
  const {key,cert}=makeCertificate(dir,'server'),env={...process.env};for(const k of Object.keys(env))if(k.startsWith('SLS_')||k==='NODE_TLS_REJECT_UNAUTHORIZED'||k==='NODE_EXTRA_CA_CERTS')delete env[k];
  Object.assign(env,{DATABASE_URL:'postgresql://invalid:invalid@127.0.0.1:1/isolated',PORT:'0',API_HOST:'127.0.0.1',JWT_SECRET:'secret de test suffisamment long pour le serveur',ADMIN_USERNAME:'test',ADMIN_PASSWORD_HASH:bcrypt.hashSync('fictif',4),SLS_REQUIRE_HTTPS:'1',SLS_TLS_KEY:key,SLS_TLS_CERT:cert,SLS_TLS_EXPECTED_HOST:'mauvais.example'});
  const result=spawnSync(process.execPath,['--import','tsx','src/server.ts'],{cwd:resolve('apps/api'),env,encoding:'utf8',timeout:15000});
  assert.notEqual(result.status,0);assert.equal(result.signal,null);assert.match(result.stderr,/ne couvre pas/);assert.doesNotMatch(result.stdout,/API de développement prête/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('API HTTPS réelle : certificat vérifié, nom contrôlé et pas de repli HTTP',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-tls-api-'));let child:ChildProcess|undefined;
 try{
  const {key,cert}=makeCertificate(dir,'server'),port=await new Promise<number>((resolve,reject)=>{const s=netServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string')return reject(Error('port'));s.close(()=>resolve(a.port));});});
  const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('SLS_')||k==='NODE_TLS_REJECT_UNAUTHORIZED'||k==='NODE_EXTRA_CA_CERTS')delete env[k];
  const adminDir=join(dir,'admin-dist');mkdirSync(join(adminDir,'assets'),{recursive:true});writeFileSync(join(adminDir,'index.html'),'<html><div id="root"></div></html>');writeFileSync(join(adminDir,'assets','app.js'),'console.log("test")');
  Object.assign(env,{DATABASE_URL:'postgresql://invalid:invalid@127.0.0.1:1/isolated',PORT:String(port),API_HOST:'127.0.0.1',JWT_SECRET:'secret de test suffisamment long pour le serveur',ADMIN_USERNAME:'test',ADMIN_PASSWORD_HASH:bcrypt.hashSync('fictif',4),SLS_REQUIRE_HTTPS:'1',SLS_TLS_KEY:key,SLS_TLS_CERT:cert,SLS_TLS_EXPECTED_HOST:'localhost',SLS_HSTS_MAX_AGE:'300',SLS_ADDRESS_HTTPS:'J_ACTIVE_HTTPS',SLS_ADMIN_STATIC_DIR:adminDir});
  child=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:resolve('apps/api'),env,stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Démarrage TLS expiré')),15000);child!.stdout!.on('data',d=>{if(String(d).includes('API de développement prête')){clearTimeout(timer);resolve();}});child!.once('exit',c=>{clearTimeout(timer);reject(Error(`API arrêtée ${c}`));});child!.stderr!.on('data',d=>process.stderr.write(d));});
  const query=(options:Record<string,unknown>)=>new Promise<{status:number;cache:string|undefined;nosniff:string|undefined;hsts:string|undefined}>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path:'/api/address-approvals',method:'POST',...options},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode??0,cache:res.headers['cache-control'],nosniff:res.headers['x-content-type-options'],hsts:res.headers['strict-transport-security']}));});req.on('error',reject);req.end();});
  await assert.rejects(query({}),/self-signed|certificate/i);
  await assert.rejects(query({ca:readFileSync(cert),servername:'incorrect.example'}),/altname|certificate/i);
  assert.deepEqual(await query({ca:readFileSync(cert)}),{status:401,cache:'no-store',nosniff:'nosniff',hsts:undefined}); // une IP ne reçoit pas HSTS
  assert.deepEqual(await query({ca:readFileSync(cert),path:'/api/login',headers:{Host:`localhost:${port}`}}),{status:401,cache:'no-store',nosniff:'nosniff',hsts:'max-age=300'});
  assert.deepEqual(await query({ca:readFileSync(cert),path:'/',method:'GET',headers:{Host:`localhost:${port}`}}),{status:200,cache:'no-store',nosniff:'nosniff',hsts:'max-age=300'});
  const checked=await checkHttpsDeployment(`https://localhost:${port}`,readFileSync(cert));assert.equal(checked.api,'refus sans session vérifié');assert.equal(checked.hsts,'max-age=300');
  assert.deepEqual(await query({ca:readFileSync(cert),path:'/',method:'GET'}),{status:421,cache:'no-store',nosniff:'nosniff',hsts:undefined});
  assert.deepEqual(await query({ca:readFileSync(cert),servername:'localhost',path:'/api/login',headers:{Host:'autre.example'}}),{status:401,cache:'no-store',nosniff:'nosniff',hsts:undefined});
  await assert.rejects(query({ca:readFileSync(cert),minVersion:'TLSv1.1',maxVersion:'TLSv1.1'}));
  const plain=await new Promise<string>((resolve,reject)=>{const socket=connect(port,'127.0.0.1',()=>socket.write('GET /api/address-approvals HTTP/1.1\r\nHost: localhost\r\n\r\n'));let data='';socket.setTimeout(3000,()=>socket.destroy());socket.on('data',d=>data+=d.toString());socket.on('end',()=>resolve(data));socket.on('close',()=>resolve(data));socket.on('error',reject);});
  assert.doesNotMatch(plain,/HTTP\/1\.[01] 2\d\d/);
 }finally{if(child&&child.exitCode===null)await new Promise<void>(resolve=>{child!.once('exit',()=>resolve());child!.kill('SIGTERM');});rmSync(dir,{recursive:true,force:true});}
});
