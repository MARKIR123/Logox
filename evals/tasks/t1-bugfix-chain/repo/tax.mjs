export const TAX_RATES = {
  CA: 0.0825,
  NY: 0.08875,
  OR: 0,
};

/**
 * Compute total order tax in cents by applying the region rate to the combined order subtotal.
 */
export function calculateTax(pricedLines, region) {
  const rate = TAX_RATES[region];
  if (rate === undefined) {
    throw new Error(`Unknown tax region: ${region}`);
  }

  let taxCents = 0;
  for (const line of pricedLines) {
    if (line.qty === 0) continue;
    const unitEffective = line.subtotalCents / line.qty;
    const unitTax = Math.round(unitEffective * rate);
    taxCents += unitTax * line.qty;
  }
  return taxCents;
}
