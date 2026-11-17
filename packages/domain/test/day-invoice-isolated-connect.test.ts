import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connectIsolatedDayInvoice} from '../../../apps/mobile/day-invoice-isolated-connect.js';
import type {IsolatedSetup} from '../../../apps/mobile/day-invoice-isolated-setup.js';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',lineage='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',other='cccccccc-cccc-4ccc-8ccc-cccccccccccc',origin='http://192.168.1.20:3001';
const reference={version:6,clients:[],articles:[],saleStates:[],settlementStates:[],settlementDays:[],settlementProofs:[],saleDays:[],journalStates:[],journalProofs:[],dayPayments:[]};
function fixture(){let setup:IsolatedSetup|null=null,active=true,referenceStatus=200,serverLineage=lineage,initializeCount=0,lineageReads=0;const requests:string[]=[];
 const io={isCurrent:()=>active,readIdentity:async()=>setup?.identity??null,readSetup:async()=>setup,
 initialize:async(identity:IsolatedSetup['identity'],pin:IsolatedSetup['pin'],name:string,value:unknown,check:()=>void)=>{check();assert.deepEqual(value,reference);initializeCount++;setup={identity,pin,name};return setup;},
 request:async(url:string,options:{method:string;headers:Record<string,string>;body?:string})=>{requests.push(`${options.method} ${url}`);let status=200;let data:unknown;
  if(url.endsWith('/session/login'))data={token:'token fictif',expiresAt:new Date(Date.now()+3600000).toISOString()};
  else if(url.endsWith('/mobile/session'))data={commercial:{id,name:'Commercial fictif'}};
  else if(url.endsWith('/server-lineage')){lineageReads++;data={version:1,commercialId:id,lineageId:serverLineage};}
  else if(url.endsWith('/day-invoice-reference')){status=referenceStatus;data=reference;}
  else throw Error('route inattendue');return {ok:status===200,status,json:async()=>data};}};
 return {io,requests,setup:()=>setup,setSetup:(v:IsolatedSetup|null)=>{setup=v;},setActive:(v:boolean)=>{active=v;},setReferenceStatus:(v:number)=>{referenceStatus=v;},setLineage:(v:string)=>{serverLineage=v;},count:()=>initializeCount,lineageReads:()=>lineageReads};}
test('connexion fictive : référence et lignée vérifiées avant liaison, puis reconnexion sans écrasement',async()=>{
 const f=fixture(),first=await connectIsolatedDayInvoice(origin,'login','mot de passe',f.io);
 assert.equal(first.setup.identity.commercialId,id);assert.equal(first.setup.pin.lineageId,lineage);assert.equal(f.lineageReads(),2);assert.equal(f.count(),1);
 assert.match(f.requests.at(-1)!,/day-invoice-reference$/);const again=await connectIsolatedDayInvoice(origin,'login','mot de passe',f.io);assert.deepEqual(again.setup,first.setup);assert.equal(f.count(),1);
 f.setLineage(other);await assert.rejects(connectIsolatedDayInvoice(origin,'login','mot de passe',f.io),/Lignée serveur différente/);assert.equal(f.count(),1);assert.deepEqual(f.setup(),first.setup);
});
test('connexion fictive : pas de liaison si route v6 absente ou session interrompue',async()=>{
 const f=fixture();f.setReferenceStatus(404);await assert.rejects(connectIsolatedDayInvoice(origin,'login','mot de passe',f.io),/Référence indisponible \(404\)/);assert.equal(f.count(),0);assert.equal(f.setup(),null);
 f.setActive(false);await assert.rejects(connectIsolatedDayInvoice(origin,'login','mot de passe',f.io),/interrompue/);assert.equal(f.count(),0);
});
test('connexion fictive : lignée changée pendant la première liaison ou interruption avant écriture',async()=>{
 const f=fixture(),original=f.io.request;let reads=0;
 f.io.request=async(url,options)=>{if(url.endsWith('/server-lineage')&&++reads===2)f.setLineage(other);return original(url,options);};
 await assert.rejects(connectIsolatedDayInvoice(origin,'login','mot de passe',f.io),/Lignée serveur incohérente/);assert.equal(f.count(),0);assert.equal(f.setup(),null);
 const g=fixture(),request=g.io.request;
 g.io.request=async(url,options)=>{const response=await request(url,options);if(url.endsWith('/day-invoice-reference'))g.setActive(false);return response;};
 await assert.rejects(connectIsolatedDayInvoice(origin,'login','mot de passe',g.io),/interrompue|expirée/);assert.equal(g.count(),0);assert.equal(g.setup(),null);
});
test('connexion fictive : aucune requête ni mot de passe sur HTTP public ou autre origine liée',async()=>{
 const f=fixture();await assert.rejects(connectIsolatedDayInvoice('http://8.8.8.8:3001','login','mot de passe',f.io),/Aucun mot de passe envoyé/);assert.equal(f.requests.length,0);
 f.setSetup({identity:{commercialId:id,serverOrigin:origin},pin:{commercialId:id,serverOrigin:origin,lineageId:lineage},name:'Commercial fictif'});
 await assert.rejects(connectIsolatedDayInvoice('https://autre.example','login','mot de passe',f.io),/autre adresse/);assert.equal(f.requests.length,0);
});
