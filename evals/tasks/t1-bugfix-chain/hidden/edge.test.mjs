import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const targetDir = process.env.TARGET_WORK_DIR;
if (!targetDir) {
  throw new Error('TARGET_WORK_DIR environment variable is required');
}
const {calculateOrder} = await import(pathToFileURL(join(targetDir, 'index.mjs')).href);

describe('order edge cases', () => {
  it('handles zero quantity items', () => {
    const result = calculateOrder('sku=ZERO-1 qty=0 price=19.99 discount=25%', 'CA');
    assert.equal(result.subtotalCents, 0);
    assert.equal(result.taxCents, 0);
    assert.equal(result.totalCents, 0);
  });

  it('handles 100 percent discount', () => {
    const result = calculateOrder('sku=FREE-1 qty=4 price=12.50 discount=100%', 'CA');
    assert.equal(result.subtotalCents, 0);
    assert.equal(result.taxCents, 0);
    assert.equal(result.totalCents, 0);
  });

  it('clamps fixed discount larger than gross amount to zero', () => {
    const result = calculateOrder('sku=CAP-1 qty=1 price=8.00 discount=$15.00', 'CA');
    assert.equal(result.subtotalCents, 0);
    assert.equal(result.taxCents, 0);
    assert.equal(result.totalCents, 0);
  });

  it('computes combined multi-line order with mixed discounts and tax', () => {
    const input = [
      'sku=A qty=3 price=1.00',
      'sku=B qty=2 price=15.00 discount=20%',
      'sku=C qty=1 price=10.00 discount=$2.50',
    ].join('\n');
    const result = calculateOrder(input, 'NY');
    // Line A: 300, Line B: 2400, Line C: 750 => subtotal = 3450
    // Tax: round(3450 * 0.08875) = round(306.1875) = 306
    assert.equal(result.subtotalCents, 3450);
    assert.equal(result.taxCents, 306);
    assert.equal(result.totalCents, 3756);
  });

  it('throws on negative quantity or negative price', () => {
    assert.throws(() => calculateOrder('sku=NEG-Q qty=-2 price=5.00', 'CA'));
    assert.throws(() => calculateOrder('sku=NEG-P qty=2 price=-5.00', 'CA'));
  });

  it('throws on out-of-range percentage discount or unknown tax region', () => {
    assert.throws(() => calculateOrder('sku=BAD-D qty=1 price=10.00 discount=120%', 'CA'));
    assert.throws(() => calculateOrder('sku=REG-1 qty=1 price=10.00', 'TX'));
  });
});
