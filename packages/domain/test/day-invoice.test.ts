import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateDayInvoice} from '../src/day-invoice.js';

test('facture unique : préétablie et ventes sont additionnées sans imputer deux fois les paiements existants',()=>{
 const value=calculateDayInvoice({preInvoice:{id:'p',total:600000,paid:100000,declared:true},sales:[{id:'s',total:250000,paid:50000}],dayPayments:[{id:'d',amount:200000}]});
 assert.deepEqual(value,{total:850000,alreadyPaid:150000,dayPayments:200000,remaining:500000,unrecognizedPreInvoice:0});
});
test('préétablie non déclarée signalée séparément du calcul du total de la journée',()=>{
 assert.deepEqual(calculateDayInvoice({preInvoice:{id:'p',total:600000,paid:0,declared:false},sales:[{id:'s',total:250000,paid:0}],dayPayments:[]}),{total:850000,alreadyPaid:0,dayPayments:0,remaining:850000,unrecognizedPreInvoice:600000});
});
test('rejette dépassement, montants erronés et doublons au lieu de compter deux fois',()=>{
 const base={preInvoice:null,sales:[{id:'s',total:250000,paid:50000}],dayPayments:[]};
 assert.throws(()=>calculateDayInvoice({...base,dayPayments:[{id:'a',amount:200001}]}));
 assert.throws(()=>calculateDayInvoice({...base,dayPayments:[{id:'a',amount:1},{id:'a',amount:1}]}));
 assert.throws(()=>calculateDayInvoice({...base,sales:[...base.sales,...base.sales]}));
 assert.throws(()=>calculateDayInvoice({...base,sales:[{id:'s',total:1.5,paid:0}]}));
 assert.throws(()=>calculateDayInvoice({preInvoice:{id:'p',total:100,paid:1,declared:false},sales:[],dayPayments:[]}));
 assert.throws(()=>calculateDayInvoice({...base,sales:[{id:'a',total:Number.MAX_SAFE_INTEGER,paid:0},{id:'b',total:1,paid:0}]}));
});
test('un crédit existant ne devient pas une dette et ne permet pas un règlement supplémentaire',()=>{
 const base={preInvoice:null,sales:[{id:'s',total:100,paid:150}],dayPayments:[]};
 assert.equal(calculateDayInvoice(base).remaining,-50);
 assert.throws(()=>calculateDayInvoice({...base,dayPayments:[{id:'d',amount:1}]}));
});

import {reconcileDayInvoicePayments, type DayInvoicePayment} from '../src/day-invoice.js';
const clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const payment=(operationId:string,amount:number):DayInvoicePayment=>({operationId,clientId,day:'2026-01-01',recordedAt:'2026-01-01T12:00:00.000Z',amount,mode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:'',preInvoice:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',version:1,total:600000,declare:true},sales:[{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',version:1}]});
const a='11111111-1111-4111-8111-111111111111', b='22222222-2222-4222-8222-222222222222';
const pre=(declared:boolean)=>[{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',total:600000,declared}];
test('reprise après réponse perdue : un paiement serveur et local identique ne se déduit pas deux fois',()=>{
 assert.deepEqual(reconcileDayInvoicePayments(700000,clientId,'2026-01-01',[payment(a,150000)],[payment(a,150000)],pre(true)),{balance:700000,pendingAmount:0,pendingDeclaration:0,remoteOnly:[]});
 assert.deepEqual(reconcileDayInvoicePayments(850000,clientId,'2026-01-01',[payment(a,150000)],[],pre(false)),{balance:1300000,pendingAmount:150000,pendingDeclaration:600000,remoteOnly:[]});
});
test('deux téléphones : opérations serveur supplémentaires incluses, divergence et doublons refusés',()=>{
 assert.deepEqual(reconcileDayInvoicePayments(650000,clientId,'2026-01-01',[payment(a,150000)],[payment(a,150000),{...payment(b,50000),preInvoice:{...payment(b,50000).preInvoice!,declare:false}}],pre(true)),{balance:650000,pendingAmount:0,pendingDeclaration:0,remoteOnly:[b]});
 assert.throws(()=>reconcileDayInvoicePayments(650000,clientId,'2026-01-01',[payment(a,150000)],[payment(a,100000)],pre(true)),/divergent/);
 assert.throws(()=>reconcileDayInvoicePayments(650000,clientId,'2026-01-01',[payment(a,150000),payment(a,150000)],[],pre(false)),/dupliqué/);
 assert.throws(()=>reconcileDayInvoicePayments(650000,clientId,'2026-01-01',[{...payment(a,1),day:'2026-02-30'}],[],pre(false)),/Date/);
 assert.throws(()=>reconcileDayInvoicePayments(650000,clientId,'2026-01-01',[{...payment(a,1),mode:'Chèque'}],[],pre(false)),/chèque/);
});

test('un paiement d’un autre client ou d’une autre journée ne peut pas affecter le solde',()=>{
 assert.throws(()=>reconcileDayInvoicePayments(1000,clientId,'2026-01-02',[payment(a,1)],[],pre(false)),/autre/);
 assert.throws(()=>reconcileDayInvoicePayments(1000,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-01-01',[],[payment(a,1)],pre(true)),/autre/);
});

import {validateDayInvoiceWrite} from '../src/day-invoice.js';
const source={clientId,day:'2026-01-01',preInvoice:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',version:1,total:600000,paid:0,declared:false},sales:[{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',version:1,total:250000,paid:0}],dayPayments:[]};
test('écriture unifiée : source complète, versions contrôlées et déclaration de préétablie explicite',()=>{
 const event=payment(a,200000);
 assert.deepEqual(validateDayInvoiceWrite(event,source),{total:850000,alreadyPaid:0,dayPayments:200000,remaining:650000,unrecognizedPreInvoice:600000,declaresPreInvoice:true});
 assert.throws(()=>validateDayInvoiceWrite(event,{...source,preInvoice:{...source.preInvoice,version:2}}),/actualisation/);
 assert.throws(()=>validateDayInvoiceWrite(event,{...source,sales:[{...source.sales[0],version:2}]}),/actualisation/);
 assert.throws(()=>validateDayInvoiceWrite(event,{...source,sales:[]}),/actualisation/);
 assert.throws(()=>validateDayInvoiceWrite(event,{...source,preInvoice:{...source.preInvoice,declared:true}}),/actualisation/);
 assert.throws(()=>validateDayInvoiceWrite(payment(a,900000),source),/supérieur/);
});
test('la preuve d’une opération est immuable : version divergente ou source dupliquée refusée',()=>{
 const event=payment(a,1000);
 assert.throws(()=>reconcileDayInvoicePayments(1000,clientId,'2026-01-01',[event],[{...event,sales:[{...event.sales[0],version:2}]}],pre(true)),/divergent/);
 assert.throws(()=>validateDayInvoiceWrite({...event,sales:[event.sales[0],event.sales[0]]},source),/dupliquées/);
});

test('une préétablie déclarée localement est ajoutée une seule fois au solde, une déclaration concurrente est refusée',()=>{
 const first=payment(a,150000), second=payment(b,50000);
 assert.deepEqual(reconcileDayInvoicePayments(250000,clientId,'2026-01-01',[first],[],pre(false)),{balance:700000,pendingAmount:150000,pendingDeclaration:600000,remoteOnly:[]});
 assert.deepEqual(reconcileDayInvoicePayments(700000,clientId,'2026-01-01',[first],[first],pre(true)),{balance:700000,pendingAmount:0,pendingDeclaration:0,remoteOnly:[]});
 assert.throws(()=>reconcileDayInvoicePayments(700000,clientId,'2026-01-01',[second],[first],pre(true)),/Déclarations/);
});

test('refuse de redéclarer une préétablie déjà comptabilisée par un autre protocole ou absente du snapshot',()=>{
 const event=payment(a,1000);
 assert.throws(()=>reconcileDayInvoicePayments(600000,clientId,'2026-01-01',[event],[],pre(true)),/déclaration serveur/i);
 assert.throws(()=>reconcileDayInvoicePayments(600000,clientId,'2026-01-01',[event],[],[]),/déclaration serveur/i);
 assert.throws(()=>reconcileDayInvoicePayments(600000,clientId,'2026-01-01',[event],[event],pre(false)),/instantané/i);
});

test('une charge locale inconnue ne peut pas être acceptée puis bloquer indéfiniment son envoi',async()=>{
 const {validateDayPayment}=await import('../src/day-invoice.js');
 const event=payment(a,1000);
 assert.throws(()=>validateDayPayment({...event,unknown:'non synchronisable'} as DayInvoicePayment),/Contenu/);
 assert.throws(()=>validateDayPayment(null as unknown as DayInvoicePayment),/Contenu/);
 assert.throws(()=>validateDayPayment({...event,operationId:{toString:()=>a} as unknown as string}),/Identifiant/);
 assert.throws(()=>validateDayPayment({...event,sales:[{id:{toString:()=>event.sales[0].id} as unknown as string,version:1}]}),/Preuves/);
});

test('ancienne dette exclut le reste de la facture du jour, déclarée ou non',async()=>{
 const {availablePriorDebt}=await import('../src/day-invoice.js');
 assert.equal(availablePriorDebt(550000,{remaining:650000,unrecognizedPreInvoice:600000}),500000);
 assert.equal(availablePriorDebt(1150000,{remaining:650000,unrecognizedPreInvoice:0}),500000);
 assert.equal(availablePriorDebt(10000,{remaining:100000,unrecognizedPreInvoice:0}),0);
 assert.throws(()=>availablePriorDebt(NaN,{remaining:0,unrecognizedPreInvoice:0}),/invalide/);
});
