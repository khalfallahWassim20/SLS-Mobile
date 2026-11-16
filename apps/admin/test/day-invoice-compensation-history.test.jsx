import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DayInvoiceCompensationHistory} from '../src/day-invoice-compensation-history.jsx';

test('historique facture du jour : choix distinct et versement non présumé',()=>{
 const render=compensation=>renderToStaticMarkup(<DayInvoiceCompensationHistory compensation={compensation}/>);
 assert.equal(render(undefined),'');
 assert.match(render({choice:'refund',amount:50000}),/remboursement de 50,000 DT/);
 assert.match(render({choice:'credit',amount:1234}),/crédit client de 1,234 DT/);
 assert.match(render({choice:'refund',amount:50000}),/ne prouve pas un versement physique/);
 for(const invalid of [null,{choice:'x',amount:1},{choice:'credit',amount:0},{choice:'credit',amount:1.5},{choice:'refund',amount:Infinity}])assert.match(render(invalid),/incohérent/);
});
