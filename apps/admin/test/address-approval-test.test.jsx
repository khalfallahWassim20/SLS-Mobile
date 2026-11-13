import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AddressApprovalTest} from '../src/address-approval-test.jsx';
test('autorisation essai : refuse un contexte navigateur non sécurisé',()=>{
 const html=renderToStaticMarkup(<AddressApprovalTest request={()=>{throw Error('pas d’appel')}} commercials={[]}/>);
 assert.match(html,/Contexte sécurisé requis/);assert.doesNotMatch(html,/Autoriser l’essai/);
});
