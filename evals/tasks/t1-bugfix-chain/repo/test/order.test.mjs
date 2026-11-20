import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {calculateOrder} from '../index.mjs';

describe('calculateOrder', () => {
  it('computes subtotal and tax for a plain single-unit item', () => {
    const result = calculateOrder('sku=ITEM-1 qty=1 price=20.00', 'CA');
    assert.equal(result.subtotalCents, 2000);
    assert.equal(result.taxCents, 165);
    assert.equal(result.totalCents, 2165);
  });

  it('rejects malformed input lines', () => {
    assert.throws(() => calculateOrder('sku=BAD qty=-1 price=10.00', 'CA'));
    assert.throws(() => calculateOrder('invalid-token', 'CA'));
  });

  it('applies percentage discount to line gross', () => {
    const result = calculateOrder('sku=WIDGET-A qty=2 price=20.00 discount=10%', 'OR');
    assert.equal(result.subtotalCents, 3600);
    assert.equal(result.taxCents, 0);
    assert.equal(result.totalCents, 3600);
  });

  it('applies fixed dollar discount to line gross', () => {
    const result = calculateOrder('sku=BOOK-B qty=1 price=30.00 discount=$5.00', 'OR');
    assert.equal(result.subtotalCents, 2500);
    assert.equal(result.taxCents, 0);
    assert.equal(result.totalCents, 2500);
  });

  it('calculates regional tax accurately across multi-unit quantities', () => {
    const result = calculateOrder('sku=PEN-C qty=3 price=1.00', 'CA');
    assert.equal(result.subtotalCents, 300);
    assert.equal(result.taxCents, 25);
    assert.equal(result.totalCents, 325);
  });
});
