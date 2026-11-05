import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialTourClosure,assertTourWritable,transitionTourClosure} from '../src/tour-closure.js';
const commercial={id:'commercial-1',role:'commercial' as const};
const admin={id:'admin-1',role:'admin' as const};
const when='2026-11-05T18:00:00.000Z';
test('clôture par le commercial, blocage des écritures et réouverture par admin tracée',()=>{
 const open=initialTourClosure('commercial-1','2026-11-05'); assertTourWritable(open);
 const closed=transitionTourClosure(open,'close',commercial,when,0);
 assert.deepEqual(closed.event,{commercialId:'commercial-1',day:'2026-11-05',action:'close',actorId:'commercial-1',actorRole:'commercial',at:when,version:1});
 assert.throws(()=>assertTourWritable(closed.state),/clôturé/);
 assert.throws(()=>transitionTourClosure(closed.state,'reopen',commercial,when,1),/administrateur/);
 const reopened=transitionTourClosure(closed.state,'reopen',admin,'2026-11-05T19:00:00.000Z',1);
 assert.equal(reopened.event.actorRole,'admin'); assert.equal(reopened.event.version,2); assert.equal(reopened.state.closedAt,null); assertTourWritable(reopened.state);
 const closedAgain=transitionTourClosure(reopened.state,'close',commercial,'2026-11-05T20:00:00.000Z',2);
 assert.equal(closedAgain.state.version,3); assert.equal(open.status,'open'); assert.equal(closed.state.status,'closed');
});
test('un commercial ne peut pas clôturer le journal d’un autre commercial',()=>{
 const open=initialTourClosure('commercial-2','2026-11-05');
 assert.throws(()=>transitionTourClosure(open,'close',commercial,when,0),/autre commercial/);
});
test('versions périmées et transitions répétées refusées',()=>{
 const open=initialTourClosure('commercial-1','2026-11-05');
 assert.throws(()=>transitionTourClosure(open,'reopen',admin,when,0),/déjà ouvert/);
 const closed=transitionTourClosure(open,'close',commercial,when,0).state;
 assert.throws(()=>transitionTourClosure(closed,'reopen',admin,when,0),/Version/);
 assert.throws(()=>transitionTourClosure(closed,'close',admin,when,1),/déjà clôturé/);
});
test('refuse dates, identités et états incohérents',()=>{
 assert.throws(()=>initialTourClosure('','2026-11-05'));
 assert.throws(()=>initialTourClosure('commercial-1','2026-02-30'));
 const open=initialTourClosure('commercial-1','2026-11-05');
 assert.throws(()=>transitionTourClosure(open,'close',commercial,'2026-11-05',0));
 assert.throws(()=>assertTourWritable({...open,status:'closed',closedAt:null}));
 assert.throws(()=>transitionTourClosure(open,'close',{id:'x',role:'commercial'},when,-1));
});
