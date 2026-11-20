import {parseOrderLines} from './parse.mjs';
import {priceOrder} from './pricing.mjs';
import {calculateTax} from './tax.mjs';

/**
 * Parse raw order text, apply pricing/discounts, and compute regional tax and grand total.
 */
export function calculateOrder(input, region = 'CA') {
  const parsed = parseOrderLines(input);
  const lines = priceOrder(parsed);
  const subtotalCents = lines.reduce((sum, line) => sum + line.subtotalCents, 0);
  const taxCents = calculateTax(lines, region);
  const totalCents = subtotalCents + taxCents;
  return {lines, subtotalCents, taxCents, totalCents};
}
