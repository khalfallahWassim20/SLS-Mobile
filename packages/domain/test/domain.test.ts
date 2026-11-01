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
