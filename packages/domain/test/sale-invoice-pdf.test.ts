import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateInvoice} from '../src/index.js';
import {dt,invoiceLineAmounts,saleInvoiceHtml,type InvoicePdfLine} from '../../../apps/mobile/sale-invoice-pdf.js';

test('facture PDF : prix TTC du catalogue, remise et total exact selon le calcul métier',()=>{
 const lines:InvoicePdfLine[]=[{name:'Huile moteur',code:'H1',quantity:3,unitPrice:210084,unitTtc:250000,discountRate:500,vatRate:1900},{name:'Filtre',code:'F1',quantity:2,unitPrice:1000,unitTtc:1190,discountRate:0,vatRate:1900},{name:'Accessoire',code:'A1',quantity:1,unitPrice:1000,discountRate:0,vatRate:0}];
 const totals=calculateInvoice(lines),amounts=invoiceLineAmounts(lines,totals);assert.equal(amounts[0].unitTtc,250000);assert.equal(amounts[1].unitTtc,1190);assert.equal(amounts[2].unitTtc,1000);assert.equal(amounts.reduce((a,b)=>a+b.totalTtc,0),totals.total);
 const html=saleInvoiceHtml({client:{name:'Client',sector:'Sud'},commercial:'Commercial',issuedAt:'16/11/2026 14:30',lines,totals});
 assert.match(html,/@page\{size:A4/);assert.match(html,/PRIX UNIT\. TTC/);assert.match(html,/TOTAL TTC/);assert.match(html,/250\.000 DT/);assert.match(html,/1\.190 DT/);assert.match(html,/5 %/);assert.match(html,/avant validation/i);assert.match(html,/ne constitue pas une facture officielle/);assert.equal(dt(1),'0.001 DT');
});

test('facture PDF : répartition TVA exacte pour des centimes et taux variés',()=>{
 for(let seed=1;seed<150;seed++){
  const lines=Array.from({length:7},(_,i)=>({name:`Article ${i}`,code:`${i}`,quantity:1+(seed+i)%5,unitPrice:1+((seed*97+i*37)%10000),discountRate:((seed+i)%4)*500,vatRate:[0,700,1300,1900][(seed+i)%4]}));
  const totals=calculateInvoice(lines),amounts=invoiceLineAmounts(lines,totals);assert.equal(amounts.reduce((a,b)=>a+b.totalTtc,0),totals.total);
  for(const group of totals.vatByRate){const sum=amounts.reduce((a,item,i)=>a+(lines[i].vatRate===group.rate?item.totalTtc:0),0);assert.equal(sum,group.base+group.vat);}
 }
});

test('facture PDF : échappe les données client et rejette les totaux ou lignes invalides',()=>{
 const lines=[{name:'<script>alert(1)</script>',code:'A&1',quantity:1,unitPrice:1000,discountRate:0,vatRate:1900}],totals=calculateInvoice(lines);
 const input={client:{name:'<img src=x>',sector:'Sud & Nord'},commercial:'A < B',issuedAt:'01/01/2026',lines,totals};
 const html=saleInvoiceHtml(input);assert.doesNotMatch(html,/<script>|<img src=x>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/Sud &amp; Nord/);assert.match(html,/A &lt; B/);
 assert.throws(()=>saleInvoiceHtml({...input,totals:{...totals,total:totals.total+1}}),/incohérents/);
 assert.throws(()=>saleInvoiceHtml({...input,totals:{...totals,vatByRate:[{...totals.vatByRate[0],vat:999999999}]}}),/incohérents/);
 assert.throws(()=>invoiceLineAmounts([{...lines[0],quantity:0}],totals),/Quantité/);assert.throws(()=>invoiceLineAmounts([{...lines[0],unitTtc:NaN}],totals),/Article/);
 assert.throws(()=>dt(Number.MAX_SAFE_INTEGER+1),/Montant/);
});
