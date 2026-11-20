/**
 * Compute line gross, discount, and net subtotal in integer cents.
 */
export function priceLine(line) {
  const grossCents = line.unitPriceCents * line.qty;
  let discountCents = 0;

  if (line.discount) {
    if (line.discount.kind === 'fixed') {
      discountCents = Math.round(grossCents * (line.discount.value / 100));
    } else if (line.discount.kind === 'percent') {
      discountCents = line.discount.value;
    } else {
      throw new Error(`Unknown discount kind: ${line.discount.kind}`);
    }
  }

  const clampedDiscount = Math.min(grossCents, Math.max(0, discountCents));
  const subtotalCents = grossCents - clampedDiscount;
  return {
    sku: line.sku,
    qty: line.qty,
    unitPriceCents: line.unitPriceCents,
    grossCents,
    discountCents: clampedDiscount,
    subtotalCents,
  };
}

export function priceOrder(lines) {
  return lines.map(priceLine);
}
