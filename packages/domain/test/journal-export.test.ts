import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { journalCsv, journalHtml } from '../../../apps/mobile/journal-export.js';

test('export local : montants, détail, échappement et protection tableur', () => {
 const data = { day:'2026-11-08', commercial:'<Commercial>', rows:[{clientId:'c',clientName:'=CLIENT',sector:'Nord; "A"',preInvoice:{id:'p',journalDate:'2026-11-08',clientId:'c',clientName:'=CLIENT',sector:'Nord',amount:600000,createdAt:'2026-11-08T10:00:00Z'},sales:[{id:1,createdAt:'2026-11-08T10:00:00Z',clientId:'c',clientName:'=CLIENT',lines:[],total:250000,paid:0,remaining:250000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''}],total:850000}],receipts:[{id:'r',preInvoiceId:'p',clientId:'c',journalDate:'2026-11-08',createdAt:'2026-11-08T10:05:00Z',prePaid:200000,oldDebtPaid:300000,creditFull:false,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1000000}] };
 const csv=journalCsv(data); assert.ok(csv.startsWith('\uFEFF')); assert.match(csv,/'=CLIENT/); assert.match(csv,/850,000/); assert.match(csv,/200,000/); assert.match(csv,/300,000/); assert.match(csv,/Nord; ""A""/);
 const html=journalHtml(data); assert.match(html,/&lt;Commercial&gt;/); assert.match(html,/850,000/); assert.doesNotMatch(html,/<Commercial>/);
});

test('export local : avoirs du jour distincts des factures et de l’ancienne dette',async()=>{
 const {randomUUID}=await import('node:crypto');
 const id=randomUUID(),client=randomUUID(),commercialId=randomUUID(),preId=randomUUID(),saleOp=randomUUID(),preOp=randomUUID();
 const invoice={id:preId,clientId:client,clientName:'=Fictif',journalDate:'2026-11-07',amount:600000,createdAt:'2026-11-07T09:00:00.000Z'};
 const receipt={id:randomUUID(),preInvoiceId:preId,clientId:client,journalDate:'2026-11-07',createdAt:'2026-11-07T10:00:00.000Z',prePaid:250000,oldDebtPaid:400000,creditFull:false,mode:'Espèces' as const,chequeNumber:'',chequeBank:'',chequeDue:'',oldDebtLimitAtStart:1000000};
 const sale={id:1,createdAt:'2026-11-08T08:00:00.000Z',clientId:client,clientName:'=Fictif',syncSaleId:id,syncVersion:1,lines:[],total:250000,paid:100000,remaining:150000,paymentMode:'Espèces',chequeNumber:'',chequeBank:'',chequeDue:''};
 const {id:_id,...source}=sale;
 const notes=[{pending:true,note:{kind:'sale' as const,commercialId,serverOrigin:'https://example.test',command:{operationId:saleOp,invoiceId:id,expectedVersion:1,recordedAt:'2026-11-08T10:00:00.000Z',choice:'refund' as const},source,balanceDelta:-150000,refund:100000,retainedCredit:0}},
  {pending:false,note:{kind:'preinvoice' as const,commercialId,serverOrigin:'https://example.test',command:{operationId:preOp,invoiceId:preId,expectedVersion:2,recordedAt:'2026-11-08T11:00:00.000Z',choice:'credit' as const},source:{version:2,invoice,receipts:[receipt]},balanceDelta:-600000,refund:0,retainedCredit:250000}}];
 const data={day:'2026-11-08',commercial:'Commercial fictif',rows:[{clientId:client,clientName:'=Fictif',sector:'',preInvoice:null,sales:[sale],total:250000}],receipts:[],credits:notes};
 const csv=journalCsv(data),html=journalHtml(data);
 assert.match(csv,/AVOIRS CRÉÉS CE JOUR/);assert.match(csv,/'=Fictif/);assert.match(csv,/facture du 2026-11-07/);assert.match(csv,/en attente/);assert.match(csv,/synchronisé/);
 assert.match(csv,/850,000/);assert.match(csv,/100,000/);assert.match(csv,/250,000/);assert.match(csv,/'-600,000/);
 assert.match(html,/AVOIRS CRÉÉS CE JOUR/);assert.match(html,/corriger séparément dans le système principal/);
 assert.throws(()=>journalCsv({...data,credits:[notes[0],notes[0]]}),/dupliqué/);
 assert.throws(()=>journalCsv({...data,credits:[{...notes[0],note:{...notes[0].note,refund:1}}]}),/incohérents/);
 const later=journalCsv({...data,day:'2026-11-09',rows:[]});assert.doesNotMatch(later,/facture du 2026-11-07/);
});
