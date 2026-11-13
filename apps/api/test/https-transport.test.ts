/** TLS local jetable : aucun accès à une base ni certificat réel. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer as netServer,connect} from 'node:net';
import {request} from 'node:https';
import {readTransportConfig} from '../src/https-config.js';
import bcrypt from 'bcryptjs';

function makeCertificate(dir:string,name:string){
 const key=join(dir,`${name}.key`),cert=join(dir,`${name}.pem`);
 const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
 assert.equal(generated.status,0,'openssl requis');return {key,cert};
}
test('configuration TLS explicite : refuse omissions, mélanges et clé incorrecte',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-tls-config-'));try{
  const first=makeCertificate(dir,'first'),second=makeCertificate(dir,'second');
  assert.equal(readTransportConfig({}).tls,null);
  assert.throws(()=>readTransportConfig({SLS_ADDRESS_HTTPS:'J_ACTIVE_HTTPS'}),/clé et un certificat/);
  assert.throws(()=>readTransportConfig({SLS_TLS_KEY:first.key}),/clé et un certificat/);
  assert.throws(()=>readTransportConfig({SLS_TLS_KEY:second.key,SLS_TLS_CERT:first.cert}),/correspond pas/);
  assert.throws(()=>readTransportConfig({SLS_TLS_KEY:first.key,SLS_TLS_CERT:first.cert,SLS_ADDRESS_PRIVATE_HTTP:'J_ACCEPTE_LES_RISQUES_HTTP'}),/HTTP privé/);
  assert.throws(()=>readTransportConfig({SLS_ADDRESS_TEST_TLS_KEY:first.key}),/paramètres TLS de test/);
  assert.throws(()=>readTransportConfig({SLS_ADDRESS_TEST_ONLY:'DONNEES_FICTIVES_ISOLEES',SLS_V5_TEST_ONLY:'DONNEES_FICTIVES_ISOLEES',SLS_ADDRESS_TEST_TLS_KEY:first.key,SLS_ADDRESS_TEST_TLS_CERT:first.cert,SLS_TLS_KEY:second.key}),/mélanger/);
  const config=readTransportConfig({SLS_TLS_KEY:first.key,SLS_TLS_CERT:first.cert,SLS_ADDRESS_HTTPS:'J_ACTIVE_HTTPS'});
  assert.equal(config.addressHttps,true);assert.equal(config.tls?.minVersion,'TLSv1.2');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('API HTTPS réelle : certificat vérifié, nom contrôlé et pas de repli HTTP',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sls-tls-api-'));let child:ChildProcess|undefined;
 try{
  const {key,cert}=makeCertificate(dir,'server'),port=await new Promise<number>((resolve,reject)=>{const s=netServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string')return reject(Error('port'));s.close(()=>resolve(a.port));});});
  const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('SLS_')||k==='NODE_TLS_REJECT_UNAUTHORIZED'||k==='NODE_EXTRA_CA_CERTS')delete env[k];
  Object.assign(env,{DATABASE_URL:'postgresql://invalid:invalid@127.0.0.1:1/isolated',PORT:String(port),API_HOST:'127.0.0.1',JWT_SECRET:'secret de test suffisamment long pour le serveur',ADMIN_USERNAME:'test',ADMIN_PASSWORD_HASH:bcrypt.hashSync('fictif',4),SLS_TLS_KEY:key,SLS_TLS_CERT:cert,SLS_ADDRESS_HTTPS:'J_ACTIVE_HTTPS'});
  child=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:resolve('apps/api'),env,stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Démarrage TLS expiré')),15000);child!.stdout!.on('data',d=>{if(String(d).includes('API de développement prête')){clearTimeout(timer);resolve();}});child!.once('exit',c=>{clearTimeout(timer);reject(Error(`API arrêtée ${c}`));});child!.stderr!.on('data',d=>process.stderr.write(d));});
  const query=(options:Record<string,unknown>)=>new Promise<number>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path:'/api/address-approvals',method:'POST',...options},res=>{res.resume();res.on('end',()=>resolve(res.statusCode??0));});req.on('error',reject);req.end();});
  await assert.rejects(query({}),/self-signed|certificate/i);
  await assert.rejects(query({ca:readFileSync(cert),servername:'incorrect.example'}),/altname|certificate/i);
  assert.equal(await query({ca:readFileSync(cert)}),401); // route montée, authentification requise
  await assert.rejects(query({ca:readFileSync(cert),minVersion:'TLSv1.1',maxVersion:'TLSv1.1'}));
  const plain=await new Promise<string>((resolve,reject)=>{const socket=connect(port,'127.0.0.1',()=>socket.write('GET /api/address-approvals HTTP/1.1\r\nHost: localhost\r\n\r\n'));let data='';socket.setTimeout(3000,()=>socket.destroy());socket.on('data',d=>data+=d.toString());socket.on('end',()=>resolve(data));socket.on('close',()=>resolve(data));socket.on('error',reject);});
  assert.doesNotMatch(plain,/HTTP\/1\.[01] 2\d\d/);
 }finally{if(child&&child.exitCode===null)await new Promise<void>(resolve=>{child!.once('exit',()=>resolve());child!.kill('SIGTERM');});rmSync(dir,{recursive:true,force:true});}
});
