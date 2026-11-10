import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shareCreditJournalPrototype} from '../../../apps/mobile/credit-note-share-prototype.js';
import type {JournalExport} from '../../../apps/mobile/journal-export.js';

test('partage v5 hors ligne : CSV, PDF, validation et erreurs sans suppression',async()=>{
 const data:JournalExport={day:'2026-11-08',commercial:'Commercial fictif',rows:[],receipts:[],credits:[]};
 const writes:{uri:string;data:string;encoding:string}[]=[],shares:string[]=[],prints:string[]=[];
 const io={cacheDirectory:'file:///cache/',available:async()=>true,write:async(uri:string,text:string,encoding:'utf8'|'base64')=>{writes.push({uri,data:text,encoding});},print:async(html:string)=>{prints.push(html);return {base64:'UEZG'};},share:async(uri:string)=>{shares.push(uri);},now:()=>42};
 assert.equal(await shareCreditJournalPrototype(data,'csv',io),'file:///cache/journal-2026-11-08-42.csv');
 assert.ok(writes[0].data.startsWith('\uFEFF'));assert.equal(writes[0].encoding,'utf8');
 assert.equal(await shareCreditJournalPrototype(data,'pdf',io),'file:///cache/journal-2026-11-08-42.pdf');
 assert.equal(writes[1].data,'UEZG');assert.equal(writes[1].encoding,'base64');assert.match(prints[0],/Journal/);assert.equal(shares.length,2);
 await assert.rejects(shareCreditJournalPrototype({...data,day:'2026-02-30'},'csv',io),/invalide/);
 await assert.rejects(shareCreditJournalPrototype({...data,credits:undefined},'csv',io),/invalide/);
 await assert.rejects(shareCreditJournalPrototype(data,'csv',{...io,available:async()=>false}),/partage/);
 await assert.rejects(shareCreditJournalPrototype(data,'csv',{...io,cacheDirectory:null}),/Stockage/);
 await assert.rejects(shareCreditJournalPrototype(data,'pdf',{...io,print:async()=>({})}),/PDF/);
 await assert.rejects(shareCreditJournalPrototype(data,'csv',{...io,write:async()=>{throw Error('disque');}}),/disque/);
 assert.equal(shares.length,2); // aucune erreur n'est présentée comme un partage réussi
});
