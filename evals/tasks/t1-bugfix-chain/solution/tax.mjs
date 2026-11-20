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

  const subtotalCents = pricedLines.reduce((sum, line) => sum + line.subtotalCents, 0);
  return Math.round(subtotalCents * rate);
}
