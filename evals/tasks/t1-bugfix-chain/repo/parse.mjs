/**
 * Parse order text lines into normalized line-item objects.
 * Format per line: `sku=<SKU> qty=<INT> price=<DOLLARS> [discount=<PCT>%|$<DOLLARS>]`
 */
export function parseOrderLines(input) {
  if (typeof input !== 'string') {
    throw new Error('Order input must be a string');
  }
  const lines = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const fields = new Map();
    for (const token of trimmed.split(/\s+/)) {
      const eq = token.indexOf('=');
      if (eq <= 0) {
        throw new Error(`Invalid order token: ${token}`);
      }
      fields.set(token.slice(0, eq), token.slice(eq + 1));
    }

    const sku = fields.get('sku');
    if (!sku) {
      throw new Error('Missing required field: sku');
    }

    const qtyRaw = fields.get('qty');
    const qty = Number(qtyRaw);
    if (qtyRaw === undefined || !Number.isInteger(qty) || qty < 0) {
      throw new Error(`Invalid qty for ${sku}: ${qtyRaw}`);
    }

    const priceRaw = fields.get('price');
    const priceNum = Number(priceRaw);
    if (priceRaw === undefined || !Number.isFinite(priceNum) || priceNum < 0) {
      throw new Error(`Invalid price for ${sku}: ${priceRaw}`);
    }
    const unitPriceCents = Math.round(priceNum * 100);

    let discount = null;
    const discountRaw = fields.get('discount');
    if (discountRaw !== undefined) {
      if (discountRaw.endsWith('%')) {
        const pct = Number(discountRaw.slice(0, -1));
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          throw new Error(`Invalid percentage discount for ${sku}: ${discountRaw}`);
        }
        discount = {kind: 'percent', value: pct};
      } else if (discountRaw.startsWith('$')) {
        const dollars = Number(discountRaw.slice(1));
        if (!Number.isFinite(dollars) || dollars < 0) {
          throw new Error(`Invalid fixed discount for ${sku}: ${discountRaw}`);
        }
        discount = {kind: 'fixed', value: Math.round(dollars * 100)};
      } else {
        throw new Error(`Unsupported discount format for ${sku}: ${discountRaw}`);
      }
    }

    lines.push({sku, qty, unitPriceCents, discount});
  }
  return lines;
}
