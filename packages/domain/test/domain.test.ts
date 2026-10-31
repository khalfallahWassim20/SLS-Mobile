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
