import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {compareSaleCashEvents} from '../../../apps/mobile/credit-sale-cash-compare-prototype.js';

test('comparaison des flux de vente : identité, opérations, montants et jour vérifiés',()=>{
 const identity={commercialId:randomUUID(),serverOrigin:'https://example.test'},day='2026-11-08',saleId=randomUUID(),clientId=randomUUID();
 const first={operationId:randomUUID(),saleId,clientId,recordedAt:'2026-11-07T23:30:00.000Z',paid:50000};
 const refund={operationId:randomUUID(),saleId,clientId,recordedAt:'2026-11-08T10:00:00.000Z',refund:38100};
 const report={version:5,commercialId:identity.commercialId,day,initialEvents:[first],refundEvents:[refund]};
 const compare=(server:unknown)=>compareSaleCashEvents(report,server,identity,day);
 assert.deepEqual(compare(report),{matches:true,onlyLocal:0,onlyServer:0,changed:0});
 assert.deepEqual(compare({...report,initialEvents:[{...first,paid:49999}]}),{matches:false,onlyLocal:0,onlyServer:0,changed:1});
 // Même montant global ne prouve pas que les mêmes opérations ont été reçues.
 assert.deepEqual(compare({...report,refundEvents:[{...refund,operationId:randomUUID()}]}),{matches:false,onlyLocal:1,onlyServer:1,changed:0});
 assert.deepEqual(compare({...report,initialEvents:[]}),{matches:false,onlyLocal:1,onlyServer:0,changed:0});
 assert.throws(()=>compare({...report,commercialId:randomUUID()}),/identité différente/);
 assert.throws(()=>compare({...report,refundEvents:[refund,refund]}),/doublés/);
 assert.throws(()=>compare({...report,refundEvents:[{...refund,recordedAt:'2026-11-09T10:00:00.000Z'}]}),/invalides/);
 assert.throws(()=>compare({...report,refundEvents:[{...refund,refund:-1}]}),/invalide/);
 assert.throws(()=>compare({...report,initialEvents:[{...first,extra:1}]}),/invalide/);
 assert.throws(()=>compareSaleCashEvents({...report,day:'2026-02-30'},{...report,day:'2026-02-30'},identity,'2026-02-30'),/Date/);
});
