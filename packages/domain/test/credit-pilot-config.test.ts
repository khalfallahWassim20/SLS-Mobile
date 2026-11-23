import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCreditProtocolConfig,creditAllowedForCommercial} from '../../../apps/api/src/credit-pilot-config.js';
const pilot='AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',ack='J_ACCEPTE_UN_PILOTE_AVOIRS',fake='DONNEES_FICTIVES_ISOLEES';
test('avoirs : arrêtés par défaut, pour personne',()=>{
 const c=parseCreditProtocolConfig({});assert.deepEqual(c,{mode:'off',enabled:false,pilotCommercialId:null});
 assert.equal(creditAllowedForCommercial(c,pilot),false);
 assert.equal(parseCreditProtocolConfig({SLS_V5_TEST_ONLY:'1'}).enabled,false);
});
test('avoirs : essai fictif ouvert à tous les commerciaux de la base fictive',()=>{
 const c=parseCreditProtocolConfig({SLS_V5_TEST_ONLY:fake});assert.equal(c.mode,'test');assert.equal(creditAllowedForCommercial(c,other),true);
});
test('avoirs : le pilote réel est limité à un seul commercial',()=>{
 const c=parseCreditProtocolConfig({SLS_V5_PILOT_COMMERCIAL_ID:` ${pilot} `,SLS_V5_PILOT_ACK:ack});
 assert.equal(c.mode,'pilot');assert.equal(creditAllowedForCommercial(c,pilot.toLowerCase()),true);assert.equal(creditAllowedForCommercial(c,pilot),true);assert.equal(creditAllowedForCommercial(c,other),false);
});
test('avoirs : configuration pilote incomplète ou ambiguë refusée',()=>{
 for(const env of [{SLS_V5_PILOT_COMMERCIAL_ID:pilot},{SLS_V5_PILOT_COMMERCIAL_ID:pilot,SLS_V5_PILOT_ACK:'oui'},{SLS_V5_PILOT_COMMERCIAL_ID:'tous',SLS_V5_PILOT_ACK:ack},{SLS_V5_PILOT_ACK:ack},{SLS_V5_PILOT_COMMERCIAL_ID:pilot,SLS_V5_PILOT_ACK:ack,SLS_V5_TEST_ONLY:fake}])assert.throws(()=>parseCreditProtocolConfig(env));
});
