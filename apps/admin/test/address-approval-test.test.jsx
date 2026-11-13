import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AddressApprovalTest,validateApprovalTarget} from '../src/address-approval-test.jsx';
test('autorisation essai : refuse un contexte navigateur non sécurisé',()=>{
 const html=renderToStaticMarkup(<AddressApprovalTest request={()=>{throw Error('pas d’appel')}} commercials={[]}/>);
 assert.match(html,/Contexte sécurisé requis/);assert.doesNotMatch(html,/Autoriser l’essai/);
});

test('adresse cible : IP privées canoniques admises uniquement avec activation HTTP',()=>{
 for(const ip of ['192.168.100.23','10.1.2.3','172.16.0.1','172.31.255.254']){
  assert.doesNotThrow(()=>validateApprovalTarget(`http://${ip}:3001`,true));
  assert.throws(()=>validateApprovalTarget(`http://${ip}:3001`,false));
 }
 for(const value of ['http://172.15.0.1:3001','http://172.32.0.1:3001','http://8.8.8.8:3001','http://localhost:3001','http://192.168.100.23:3001/path','http://192.168.100.023:3001','http://user@192.168.100.23:3001'])assert.throws(()=>validateApprovalTarget(value,true),value);
 assert.doesNotThrow(()=>validateApprovalTarget('https://example.com',false));
});
