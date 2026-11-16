import {test} from 'node:test';
import assert from 'node:assert/strict';
import {saleSyncStatus} from '../../../apps/mobile/sale-sync-status.js';
const sale={syncSaleId:'sale-1',syncVersion:2,clientId:'client',total:150000,paid:100000};
const marker={saleId:'sale-1',version:2,clientId:'client',total:'150000',paid:'100000'};
test('état de vente : aucune preuve déduite d’une file vide',()=>{
 assert.match(saleSyncStatus(sale,[],null,false),/à vérifier/);
 assert.match(saleSyncStatus(sale,[],{saleStates:[]},false),/à vérifier/);
 assert.match(saleSyncStatus(sale,[{saleId:'sale-1'}],{saleStates:[marker]},false),/attente/);
 assert.match(saleSyncStatus(sale,[],{saleStates:[marker]},true),/indisponible/);
 assert.match(saleSyncStatus({...sale,syncSaleId:undefined},[],null,false),/locale/);
});
test('état de vente : dernière référence, versions périmées et incohérences',()=>{
 assert.match(saleSyncStatus(sale,[],{saleStates:[marker]},false),/dernier téléchargement/);
 assert.match(saleSyncStatus(sale,[],{saleStates:[{...marker,version:1}]},false),/non confirmée/);
 for(const changed of [{...marker,version:3},{...marker,clientId:'autre'},{...marker,total:'149000'},{...marker,paid:'90000'}])assert.match(saleSyncStatus(sale,[],{saleStates:[changed]},false),/incohérent/);
 assert.match(saleSyncStatus(sale,[],{saleStates:[marker,marker]},false),/à vérifier/);
});
