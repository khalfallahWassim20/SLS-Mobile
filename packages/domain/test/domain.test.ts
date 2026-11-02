import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateInvoice, balanceAfterInvoiceChange, isSaleBlocked } from '../src/index.js';

test('calcul avec remise, TVA par taux et timbre', () => {
  const result = calculateInvoice([
    { quantity: 2, unitPrice: 10000, discountRate: 1000, vatRate: 1900 },
    { quantity: 1, unitPrice: 5000, discountRate: 0, vatRate: 700 },
  ], 1000);
  assert.deepEqual(result, { subtotal: 25000, discount: 2000, net: 23000, vat: 3770, stamp: 1000, total: 27770, vatByRate: [{ rate: 700, base: 5000, vat: 350 }, { rate: 1900, base: 18000, vat: 3420 }] });
});
test('arrondi ligne puis TVA sur la base regroupée', () => {
  const r = calculateInvoice([{ quantity: 1, unitPrice: 5, discountRate: 1000, vatRate: 1900 }, { quantity: 1, unitPrice: 5, discountRate: 1000, vatRate: 1900 }]);
  assert.equal(r.net, 10); assert.equal(r.vat, 2); assert.equal(r.total, 12);
});
test('rejet des données invalides', () => {
  assert.throws(() => calculateInvoice([]));
  assert.throws(() => calculateInvoice([{ quantity: 0, unitPrice: 1, discountRate: 0, vatRate: 0 }]));
  assert.throws(() => calculateInvoice([{ quantity: 1, unitPrice: 1, discountRate: 10001, vatRate: 0 }]));
  assert.throws(() => calculateInvoice([{ quantity: 1.5, unitPrice: 1, discountRate: 0, vatRate: 0 }]));
});
test('modification et gestion du trop-perçu', () => {
  assert.equal(balanceAfterInvoiceChange({ balance: 300000, oldTotal: 500000, oldPaid: 200000, newTotal: 600000, newPaid: 200000, refund: 0 }), 400000);
  const input = { balance: 0, oldTotal: 200000, oldPaid: 200000, newTotal: 150000, newPaid: 200000 };
  assert.equal(balanceAfterInvoiceChange({ ...input, refund: 0 }), -50000);
  assert.equal(balanceAfterInvoiceChange({ ...input, refund: 50000 }), 0);
  assert.throws(() => balanceAfterInvoiceChange({ ...input, refund: 50001 }));
});
test('plafond atteint et autorisation administrateur', () => {
  assert.equal(isSaleBlocked(1999, 2000, false), false);
  assert.equal(isSaleBlocked(2000, 2000, false), true);
  assert.equal(isSaleBlocked(2001, 2000, true), false);
  assert.equal(isSaleBlocked(100000, 0, false), false);
});

test('saisie exacte des paiements et limites', async () => {
  const { parseDinars, calculatePayment } = await import('../src/index.js');
  assert.equal(parseDinars(' 12,005 '), 12005);
  assert.equal(parseDinars('0.1'), 100);
  assert.throws(() => parseDinars('1,0001'));
  assert.throws(() => parseDinars('-1'));
  assert.throws(() => parseDinars('1e3'));
  assert.deepEqual(calculatePayment(12005, 10000), { paid: 10000, remaining: 2005 });
  assert.throws(() => calculatePayment(100, 101));
});

test('révision, remboursement et crédit restent cohérents lors de modifications successives', async () => {
  const { revisePayment } = await import('../src/index.js');
  assert.deepEqual(revisePayment(150000, 200000, 'credit'), { paid: 200000, refund: 0, remaining: 0, credit: 50000, balanceContribution: -50000 });
  assert.deepEqual(revisePayment(150000, 200000, 'refund'), { paid: 150000, refund: 50000, remaining: 0, credit: 0, balanceContribution: 0 });
  assert.deepEqual(revisePayment(250000, 200000), { paid: 200000, refund: 0, remaining: 50000, credit: 0, balanceContribution: 50000 });
  assert.equal(revisePayment(100000, 150000, 'refund').refund, 50000);
  assert.throws(() => revisePayment(100000, 150000));
});

test('solde client cumule dette initiale, ventes et crédits sans compter le remboursement deux fois', async () => {
  const { calculateClientBalance } = await import('../src/index.js');
  assert.equal(calculateClientBalance(150000, [{ total: 150000, paid: 200000 }, { total: 300000, paid: 100000 }]), 300000);
  assert.equal(calculateClientBalance(0, [{ total: 150000, paid: 200000 }]), -50000);
  assert.equal(calculateClientBalance(0, [{ total: 150000, paid: 150000 }]), 0);
  assert.throws(() => calculateClientBalance(0, [{ total: -1, paid: 0 }]));
});

test('règlement global de dette, sans trop-perçu ni double comptage', async () => {
  const { balanceAfterSettlement } = await import('../src/index.js');
  assert.equal(balanceAfterSettlement(100000, 25000), 75000);
  assert.equal(balanceAfterSettlement(100000, 100000), 0);
  assert.throws(() => balanceAfterSettlement(100000, 0));
  assert.throws(() => balanceAfterSettlement(100000, 100001));
  assert.throws(() => balanceAfterSettlement(-1000, 1));
});

test('fusion du solde serveur avec opérations locales sans double comptage', async () => {
 const { reconcileClientBalance } = await import('../src/index.js');
 const server = { serverBalance: 60000, serverSales: [{saleId:'s1',version:1,total:50000,paid:10000}], serverSettlementIds:['p1'] };
 assert.deepEqual(reconcileClientBalance({...server,localSales:[{syncSaleId:'s1',syncVersion:1,total:50000,paid:10000}],localSettlements:[{syncOperationId:'p1',amount:10000}]}),{balance:60000,conflict:false});
 assert.deepEqual(reconcileClientBalance({...server,localSales:[{syncSaleId:'s1',syncVersion:2,total:70000,paid:10000},{syncSaleId:'s2',syncVersion:1,total:30000,paid:0}],localSettlements:[{syncOperationId:'p1',amount:10000},{syncOperationId:'p2',amount:5000}]}),{balance:105000,conflict:false});
 assert.deepEqual(reconcileClientBalance({...server,localSales:[{syncSaleId:'s1',syncVersion:1,total:40000,paid:10000}],localSettlements:[]}),{balance:60000,conflict:true});
 assert.deepEqual(reconcileClientBalance({...server,serverSales:[{saleId:'s1',version:2,total:70000,paid:10000}],localSales:[{syncSaleId:'s1',syncVersion:1,total:50000,paid:10000}],localSettlements:[]}),{balance:60000,conflict:true});
});

test('réception serveur avant accusé local, crédit et remboursement sans doublon', async () => {
 const { reconcileClientBalance } = await import('../src/index.js');
 // La version et le règlement reçus sont déjà inclus dans -20 DT côté serveur.
 const common={serverBalance:-20000,serverSales:[{saleId:'x',version:2,total:100000,paid:150000}],serverSettlementIds:['p']};
 const localSales=[{syncSaleId:'x',syncVersion:2,total:100000,paid:150000}];
 const localSettlements=[{syncOperationId:'p',amount:10000}];
 assert.deepEqual(reconcileClientBalance({...common,localSales,localSettlements}),{balance:-20000,conflict:false});
 // Modification locale : remboursement de 50 DT, réduisant le crédit.
 assert.deepEqual(reconcileClientBalance({...common,localSales:[{syncSaleId:'x',syncVersion:3,total:100000,paid:100000}],localSettlements}),{balance:30000,conflict:false});
 assert.throws(()=>reconcileClientBalance({...common,localSales:[...localSales,...localSales],localSettlements}));
});
